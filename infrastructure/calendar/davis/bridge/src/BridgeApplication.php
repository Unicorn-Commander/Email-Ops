<?php

declare(strict_types=1);

/**
 * The Davis app-key bridge deliberately has no Composer dependency of its own.
 * It is loaded by the Davis image and delegates every key operation to the
 * image's bin/console, so the command contract stays the authority.
 */

final class BridgeHttpResponse
{
    /** @param array<string, mixed> $body */
    public function __construct(public readonly int $status, public readonly array $body)
    {
    }
}

final class BridgeHttpException extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

final class BridgeProtocolException extends RuntimeException
{
}

final class BridgeIdempotencyStore
{
    private const WINDOW = 600;

    /** @var callable(): int */
    private $clock;

    public function __construct(
        private readonly string $directory,
        ?callable $clock = null,
    ) {
        $this->clock = $clock ?? static fn (): int => time();
    }

    /** @param callable(): int|null $clock */
    public static function fromEnvironment(?callable $clock = null): self
    {
        $directory = getenv('BRIDGE_IDEMPOTENCY_DIR');
        $directory = $directory === false || trim($directory) === ''
            ? '/tmp/email-ops-bridge-idempotency'
            : trim($directory);

        return new self($directory, $clock);
    }

    public static function keyFor(string $callerIdentity, string $idempotencyKey): string
    {
        return hash('sha256', $callerIdentity."\0".$idempotencyKey);
    }

    /**
     * @param callable(): array<string, mixed> $create
     * @return array{result: array<string, mixed>, replayed: bool}
     */
    public function remember(
        string $callerIdentity,
        string $idempotencyKey,
        string $fingerprint,
        callable $create,
    ): array {
        $this->ensureDirectory();
        $key = self::keyFor($callerIdentity, $idempotencyKey);
        $entryPath = $this->directory.'/'.$key.'.json';
        $lockPath = $this->directory.'/'.$key.'.lock';
        $lock = fopen($lockPath, 'c+');
        if (!is_resource($lock)) {
            throw new RuntimeException('Could not open the idempotency lock.');
        }
        if (!chmod($lockPath, 0600)) {
            fclose($lock);
            throw new RuntimeException('Could not secure the idempotency lock.');
        }

        try {
            if (!flock($lock, LOCK_EX)) {
                throw new RuntimeException('Could not acquire the idempotency lock.');
            }

            try {
                $now = ($this->clock)();
                $this->purge($now);
                $cached = $this->read($entryPath);
                if ($cached !== null) {
                    if ($cached['created_at'] + self::WINDOW > $now) {
                        if (!hash_equals($cached['fingerprint'], $fingerprint)) {
                            throw new BridgeHttpException(409, 'Idempotency-Key was already used for another request.');
                        }

                        return ['result' => $cached['result'], 'replayed' => true];
                    }
                    if (is_file($entryPath)) {
                        unlink($entryPath);
                    }
                }

                $result = $create();
                $this->write($entryPath, [
                    'fingerprint' => $fingerprint,
                    'response' => $result,
                    'created_at' => ($this->clock)(),
                ]);

                return ['result' => $result, 'replayed' => false];
            } finally {
                flock($lock, LOCK_UN);
            }
        } finally {
            fclose($lock);
        }
    }

    private function ensureDirectory(): void
    {
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new RuntimeException('Could not create the idempotency directory.');
        }
        if (!chmod($this->directory, 0700)) {
            throw new RuntimeException('Could not secure the idempotency directory.');
        }
    }

    /** @return array{fingerprint: string, created_at: int, result: array<string, mixed>}|null */
    private function read(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        if (!chmod($path, 0600)) {
            return null;
        }
        $contents = file_get_contents($path);
        if ($contents === false) {
            return null;
        }

        try {
            $entry = json_decode($contents, true, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return null;
        }
        if (!is_array($entry)
            || !is_string($entry['fingerprint'] ?? null)
            || !is_int($entry['created_at'] ?? null)
            || !is_array($entry['response'] ?? null)
        ) {
            return null;
        }

        return [
            'fingerprint' => $entry['fingerprint'],
            'created_at' => $entry['created_at'],
            'result' => $entry['response'],
        ];
    }

    private function purge(int $now): void
    {
        foreach (glob($this->directory.'/*.json') ?: [] as $path) {
            $entry = $this->read($path);
            if ($entry === null || $entry['created_at'] + self::WINDOW <= $now) {
                if (is_file($path)) {
                    unlink($path);
                }
            }
        }
    }

    /** @param array{fingerprint: string, response: array<string, mixed>, created_at: int} $entry */
    private function write(string $path, array $entry): void
    {
        $encoded = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $temporary = tempnam($this->directory, '.bridge-idempotency-');
        if ($temporary === false) {
            throw new RuntimeException('Could not create the idempotency entry.');
        }

        try {
            if (!chmod($temporary, 0600)) {
                throw new RuntimeException('Could not secure the idempotency entry.');
            }
            $written = file_put_contents($temporary, $encoded, LOCK_EX);
            if ($written !== strlen($encoded) || !rename($temporary, $path)) {
                throw new RuntimeException('Could not write the idempotency entry.');
            }
            $temporary = '';
        } finally {
            if ($temporary !== '' && is_file($temporary)) {
                unlink($temporary);
            }
        }
    }
}

final class BridgeCommandResult
{
    public function __construct(
        public readonly int $exitCode,
        public readonly string $stdout,
        public readonly string $stderr,
    ) {
    }
}

interface BridgeCommandRunner
{
    /** @param list<string> $arguments */
    public function run(array $arguments): BridgeCommandResult;
}

final class ProcOpenCommandRunner implements BridgeCommandRunner
{
    public function __construct(
        private readonly string $root,
        private readonly string $phpBinary,
        private readonly string $console,
        private readonly int $timeoutSeconds = 10,
    ) {
    }

    /** @param list<string> $arguments */
    public function run(array $arguments): BridgeCommandResult
    {
        $argv = [$this->phpBinary, $this->console, ...$arguments, '--no-interaction'];
        $pipes = [];
        $process = proc_open(
            $argv,
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $this->root,
            null,
            ['bypass_shell' => true],
        );

        if (!is_resource($process)) {
            throw new BridgeProtocolException('Could not start the Davis console.');
        }

        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $stdout = '';
        $stderr = '';
        $startedAt = microtime(true);
        $timedOut = false;

        while (true) {
            $status = proc_get_status($process);
            $stdout = self::appendLimited($stdout, stream_get_contents($pipes[1]));
            $stderr = self::appendLimited($stderr, stream_get_contents($pipes[2]));

            if (!$status['running']) {
                $exitCode = (int) $status['exitcode'];
                break;
            }

            if (microtime(true) - $startedAt >= $this->timeoutSeconds) {
                proc_terminate($process, 9);
                $timedOut = true;
                $exitCode = 124;
                break;
            }

            usleep(20_000);
        }

        $stdout = self::appendLimited($stdout, stream_get_contents($pipes[1]));
        $stderr = self::appendLimited($stderr, stream_get_contents($pipes[2]));
        fclose($pipes[1]);
        fclose($pipes[2]);
        $closedCode = proc_close($process);
        if (!$timedOut && $exitCode < 0 && $closedCode >= 0) {
            $exitCode = $closedCode;
        }

        return new BridgeCommandResult($exitCode, $stdout, $stderr);
    }

    private static function appendLimited(string $current, string|false $chunk): string
    {
        if ($chunk === false || $chunk === '') {
            return $current;
        }

        $next = $current.$chunk;
        return strlen($next) > 2_000_000 ? substr($next, 0, 2_000_001) : $next;
    }
}

final class BridgeConfig
{
    /**
     * @param list<string> $allowedDomains
     * @param list<string> $allowedSources
     */
    public function __construct(
        public readonly string $tokenHash,
        public readonly array $allowedDomains,
        public readonly string $adminLogin,
        public readonly array $allowedSources,
        public readonly bool $autoCreateUsers,
    ) {
    }

    public static function fromEnvironment(): self
    {
        $hash = self::value('BRIDGE_TOKEN_SHA256');
        if (!preg_match('/\A[0-9a-fA-F]{64}\z/', $hash)) {
            throw new RuntimeException('BRIDGE_TOKEN_SHA256 must be a SHA-256 hex digest.');
        }

        $domains = array_values(array_filter(array_map(
            static fn (string $domain): string => strtolower(ltrim(trim($domain), '@')),
            explode(',', self::value('BRIDGE_ALLOWED_DOMAINS')),
        )));
        if ($domains === []) {
            throw new RuntimeException('BRIDGE_ALLOWED_DOMAINS must contain a domain.');
        }
        foreach ($domains as $domain) {
            if (!preg_match('/\A[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z/', $domain)) {
                throw new RuntimeException('BRIDGE_ALLOWED_DOMAINS contains an invalid domain.');
            }
        }

        $adminLogin = strtolower(self::value('ADMIN_LOGIN'));
        if ($adminLogin === '') {
            throw new RuntimeException('ADMIN_LOGIN is required for the bridge admin fence.');
        }

        $sources = array_values(array_filter(array_map('trim', explode(',', self::value('BRIDGE_ALLOWED_SOURCES')))));
        foreach ($sources as $source) {
            if (!self::validSource($source)) {
                throw new RuntimeException('BRIDGE_ALLOWED_SOURCES contains an invalid address.');
            }
        }

        return new self(
            strtolower($hash),
            $domains,
            $adminLogin,
            $sources,
            self::boolean('BRIDGE_AUTOCREATE_USERS', false),
        );
    }

    public function sourceAllowed(string $source): bool
    {
        if ($this->allowedSources === []) {
            return true;
        }

        foreach ($this->allowedSources as $allowed) {
            if (self::sourceMatches($source, $allowed)) {
                return true;
            }
        }

        return false;
    }

    private static function value(string $name): string
    {
        $value = getenv($name);
        return $value === false ? '' : trim($value);
    }

    private static function boolean(string $name, bool $default): bool
    {
        $value = strtolower(self::value($name));
        if ($value === '') {
            return $default;
        }

        return in_array($value, ['1', 'true', 'yes', 'on'], true);
    }

    private static function validSource(string $source): bool
    {
        $parts = explode('/', $source, 2);
        if (filter_var($parts[0], FILTER_VALIDATE_IP) === false) {
            return false;
        }
        if (count($parts) === 1) {
            return true;
        }

        if (!ctype_digit($parts[1])) {
            return false;
        }
        $bits = strlen((string) inet_pton($parts[0])) * 8;
        return (int) $parts[1] >= 0 && (int) $parts[1] <= $bits;
    }

    private static function sourceMatches(string $source, string $allowed): bool
    {
        $parts = explode('/', $allowed, 2);
        if (count($parts) === 1) {
            return hash_equals($parts[0], $source);
        }

        $sourceBinary = inet_pton($source);
        $networkBinary = inet_pton($parts[0]);
        if ($sourceBinary === false || $networkBinary === false || strlen($sourceBinary) !== strlen($networkBinary)) {
            return false;
        }

        $bits = (int) $parts[1];
        $bytes = intdiv($bits, 8);
        if ($bytes > 0 && substr($sourceBinary, 0, $bytes) !== substr($networkBinary, 0, $bytes)) {
            return false;
        }
        if ($bits % 8 === 0) {
            return true;
        }

        $mask = (0xff << (8 - ($bits % 8))) & 0xff;
        return (ord($sourceBinary[$bytes]) & $mask) === (ord($networkBinary[$bytes]) & $mask);
    }
}

final class DavisUserProvisioner
{
    public function __construct(private readonly string $root, private readonly string $environment = 'prod')
    {
    }

    public function ensure(string $login): bool
    {
        $kernel = null;
        try {
            $kernel = $this->bootKernel();
            $container = $kernel->getContainer();
            $doctrine = $container->has('doctrine')
                ? $container->get('doctrine')
                : $container->get(\Doctrine\Persistence\ManagerRegistry::class);
            $userRepository = $doctrine->getRepository(\App\Entity\User::class);
            if ($userRepository->findOneBy(['username' => $login])) {
                return true;
            }

            // IMAPAuth.php uses this exact Davis helper after a successful IMAP
            // login. Calling it here keeps principal/calendar initialization in
            // Davis instead of duplicating its entity graph in the bridge.
            $utils = $container->get(\App\Services\Utils::class);
            $utils->createPasswordlessUserWithDefaultObjects($login, $login, $login);
            $doctrine->getManager()->flush();
            return true;
        } catch (Throwable) {
            return false;
        } finally {
            // Shutdown can throw too (on Davis 5.6.2 an in-process boot lacks Davis's own .env, so resolving the
            // logger failed with LOG_FILE_PATH missing); an escape here turned a clean 409 into a 502.
            if ($kernel !== null && method_exists($kernel, 'shutdown')) {
                try {
                    $kernel->shutdown();
                } catch (Throwable) {
                }
            }
        }
    }

    private function bootKernel(): object
    {
        // Only the plain Composer autoloader: Symfony Runtime's autoload_runtime.php re-includes the running script
        // (server.php) to find the app, which redeclared the bridge's classes and killed the request (2026-10-26).
        $autoload = $this->root.'/vendor/autoload.php';
        if (!is_file($autoload)) {
            throw new RuntimeException('Davis autoloader is unavailable.');
        }
        require_once $autoload;

        if (!class_exists(\App\Kernel::class)) {
            throw new RuntimeException('Davis kernel is unavailable.');
        }

        $kernel = new \App\Kernel($this->environment, false);
        $kernel->boot();
        return $kernel;
    }
}

final class BridgeApplication
{
    private const PREFIX = 'email-ops:';
    private const DEVICE_DEFAULT_TTL = 365 * 24 * 60 * 60;
    private const DEVICE_MAX_TTL = 400 * 24 * 60 * 60;
    private const BACKEND_DEFAULT_TTL = 24 * 60 * 60;
    private const BACKEND_MAX_TTL = 24 * 60 * 60;
    /** @var callable(string): bool */
    private $ensureUser;

    /** @var callable(string): void */
    private $auditLogger;

    /** @var callable(): DateTimeImmutable|null */
    private $clock;

    private readonly BridgeIdempotencyStore $idempotencyStore;

    /** @param callable(string): void|null $auditLogger */
    public function __construct(
        private readonly BridgeConfig $config,
        private readonly BridgeCommandRunner $commands,
        callable $ensureUser,
        ?callable $auditLogger = null,
        ?callable $clock = null,
        ?BridgeIdempotencyStore $idempotencyStore = null,
    ) {
        $this->ensureUser = $ensureUser;
        $this->clock = $clock;
        $this->auditLogger = $auditLogger ?? static fn (string $line): bool => error_log($line);
        $this->idempotencyStore = $idempotencyStore ?? BridgeIdempotencyStore::fromEnvironment(
            fn (): int => $this->now()->getTimestamp(),
        );
    }

    /**
     * @param array<string, string> $headers
     * @param array<string, string> $query
     */
    public function handle(
        string $method,
        string $path,
        array $headers,
        string $body,
        string $callerIp,
        array $query = [],
    ): BridgeHttpResponse {
        $method = strtoupper($method);
        $route = parse_url($path, PHP_URL_PATH);
        if (!is_string($route)) {
            return new BridgeHttpResponse(404, ['error' => 'not_found']);
        }
        $query = $query !== [] ? $query : $this->queryFromPath($path);

        if ($method === 'GET' && $route === '/v1/health') {
            return new BridgeHttpResponse(200, ['status' => 'ok']);
        }

        $headers = $this->normalizeHeaders($headers);
        try {
            $callerIdentity = $this->authorize($headers, $callerIp);

            if ($method === 'POST' && $route === '/v1/keys') {
                return $this->create($headers, $body, $callerIp, $callerIdentity);
            }
            if ($method === 'GET' && $route === '/v1/keys') {
                return $this->list($query, $callerIp);
            }
            if ($method === 'DELETE' && preg_match('/\A\/v1\/keys\/([^\/]+)\z/', $route, $match)) {
                return $this->revoke(rawurldecode($match[1]), $callerIp);
            }

            throw new BridgeHttpException(404, 'Route not found.');
        } catch (BridgeHttpException $error) {
            return new BridgeHttpResponse($error->status, ['error' => $error->getMessage()]);
        } catch (Throwable) {
            return new BridgeHttpResponse(500, ['error' => 'Bridge operation failed.']);
        }
    }

    /** @param array<string, string> $headers */
    private function create(array $headers, string $body, string $callerIp, string $callerIdentity): BridgeHttpResponse
    {
        $input = $this->decodeBody($body);
        $request = $this->validateCreate($input);
        $idempotencyKey = $headers['idempotency-key'] ?? '';
        if ($idempotencyKey === '' || strlen($idempotencyKey) > 200 || !preg_match('/\A[\x20-\x7e]+\z/', $idempotencyKey)) {
            throw new BridgeHttpException(400, 'Idempotency-Key is required and must be printable.');
        }

        $fingerprint = hash('sha256', json_encode($request, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));

        try {
            $cached = $this->idempotencyStore->remember(
                $callerIdentity,
                $idempotencyKey,
                $fingerprint,
                fn (): array => $this->createDavisKey($request),
            );
            $result = $cached['result'];
            $this->audit(
                'create',
                $request['login'],
                $result['app_id'] ?? null,
                $request['purpose'],
                $callerIp,
                $cached['replayed'] ? 'replayed' : 'created',
            );
            return new BridgeHttpResponse(201, $result);
        } catch (BridgeHttpException $error) {
            $this->audit('create', $request['login'], null, $request['purpose'], $callerIp, 'rejected');
            throw $error;
        } catch (Throwable) {
            $this->audit('create', $request['login'], null, $request['purpose'], $callerIp, 'error');
            throw new BridgeHttpException(502, 'Davis did not accept the key request.');
        }
    }

    /** @param array<string, string> $query */
    private function list(array $query, string $callerIp): BridgeHttpResponse
    {
        $login = $this->validateLogin($query['login'] ?? null);
        try {
            $items = array_values(array_filter(
                $this->listDavisKeys(),
                static fn (array $item): bool => str_starts_with($item['name'], self::PREFIX)
                    && (in_array($login, $item['scope'], true) || in_array('*', $item['scope'], true)),
            ));
            $this->audit('list', $login, null, null, $callerIp, 'listed');
            return new BridgeHttpResponse(200, ['items' => $items]);
        } catch (Throwable) {
            $this->audit('list', $login, null, null, $callerIp, 'error');
            throw new BridgeHttpException(502, 'Davis key listing is unavailable.');
        }
    }

    private function revoke(string $appId, string $callerIp): BridgeHttpResponse
    {
        if (!preg_match('/\Aapp_[a-f0-9]{24}\z/', $appId)) {
            throw new BridgeHttpException(400, 'Invalid Davis app id.');
        }

        try {
            $before = $this->listDavisKeys();
            $key = null;
            foreach ($before as $item) {
                if ($item['app_id'] === $appId) {
                    $key = $item;
                    break;
                }
            }
            if ($key === null || !str_starts_with($key['name'], self::PREFIX)) {
                throw new BridgeHttpException(404, 'Bridge-managed key not found.');
            }

            $login = $key['scope'][0] ?? null;
            $purpose = null;
            if (preg_match('/\A'.preg_quote(self::PREFIX, '/').'([^:]+):/', $key['name'], $match)) {
                $purpose = $match[1];
            }

            $this->runRevokeCommand($appId);
            $after = $this->listDavisKeys();
            $confirmed = false;
            foreach ($after as $item) {
                if ($item['app_id'] === $appId && str_starts_with($item['name'], self::PREFIX)) {
                    $confirmed = str_starts_with($item['status'], 'revoked ');
                    break;
                }
            }
            if (!$confirmed) {
                throw new BridgeHttpException(502, 'Davis did not confirm key revocation.');
            }

            $this->audit('revoke', $login, $appId, $purpose, $callerIp, 'revoked');
            return new BridgeHttpResponse(200, ['app_id' => $appId, 'revoked' => true, 'confirmed' => true]);
        } catch (BridgeHttpException $error) {
            $this->audit('revoke', null, $appId, null, $callerIp, $error->status >= 500 ? 'error' : 'rejected');
            throw $error;
        } catch (Throwable) {
            $this->audit('revoke', null, $appId, null, $callerIp, 'error');
            throw new BridgeHttpException(502, 'Davis key revocation is unavailable.');
        }
    }

    /** @return array{login: string, label: string, purpose: string, ttl_seconds: int} */
    private function validateCreate(array $input): array
    {
        $allowed = ['login', 'label', 'purpose', 'ttl_seconds'];
        if (array_diff(array_keys($input), $allowed) !== []) {
            throw new BridgeHttpException(400, 'Unexpected key request field.');
        }

        $login = $this->validateLogin($input['login'] ?? null);
        $label = $input['label'] ?? null;
        if (!is_string($label) || $label === '' || $label !== trim($label) || strlen($label) > 64 || !preg_match('/\A[\x20-\x7e]+\z/', $label)) {
            throw new BridgeHttpException(400, 'label must be 64 or fewer printable characters.');
        }

        $purpose = $input['purpose'] ?? null;
        if (!is_string($purpose) || !in_array($purpose, ['device', 'backend'], true)) {
            throw new BridgeHttpException(400, 'purpose must be device or backend.');
        }

        $default = $purpose === 'device' ? self::DEVICE_DEFAULT_TTL : self::BACKEND_DEFAULT_TTL;
        $cap = $purpose === 'device' ? self::DEVICE_MAX_TTL : self::BACKEND_MAX_TTL;
        if (!array_key_exists('ttl_seconds', $input)) {
            $ttl = $default;
        } elseif (!is_int($input['ttl_seconds']) || $input['ttl_seconds'] < 1) {
            throw new BridgeHttpException(400, 'ttl_seconds must be a positive integer.');
        } else {
            $ttl = $input['ttl_seconds'];
        }
        if ($ttl > $cap) {
            throw new BridgeHttpException(400, 'ttl_seconds exceeds the purpose lifetime cap.');
        }

        return ['login' => $login, 'label' => $label, 'purpose' => $purpose, 'ttl_seconds' => $ttl];
    }

    private function validateLogin(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 320 || filter_var($value, FILTER_VALIDATE_EMAIL) === false) {
            throw new BridgeHttpException(400, 'login must be an email address on an allowed domain.');
        }

        $login = strtolower($value);
        if (strcasecmp($login, $this->config->adminLogin) === 0) {
            throw new BridgeHttpException(403, 'The Davis administrator cannot receive bridge keys.');
        }
        $at = strrpos($login, '@');
        $domain = $at === false ? '' : substr($login, $at + 1);
        if (!in_array($domain, $this->config->allowedDomains, true)) {
            throw new BridgeHttpException(400, 'login must be an email address on an allowed domain.');
        }

        return $login;
    }

    /** @return array<string, mixed> */
    private function createDavisKey(array $request): array
    {
        $now = $this->now();
        $expires = $now->modify('+'.$request['ttl_seconds'].' seconds');
        $name = self::PREFIX.$request['purpose'].':'.$request['label'];
        $arguments = [
            'davis:app-key:create',
            $name,
            '-u',
            $request['login'],
            '--expires-at',
            $expires->format('Y-m-d H:i:s T'),
        ];
        $result = $this->commands->run($arguments);
        if ($result->exitCode !== 0) {
            $output = $result->stdout."\n".$result->stderr;
            if (!$this->isUnknownUserOutput($output)) {
                throw new BridgeProtocolException('Unexpected Davis create failure.');
            }
            if (!$this->config->autoCreateUsers || !($this->ensureUser)($request['login'])) {
                throw new BridgeHttpException(409, 'The Davis user does not exist; sign in to Davis first or enable bridge autocreate.');
            }

            $retry = $this->commands->run($arguments);
            if ($retry->exitCode !== 0) {
                if ($this->isUnknownUserOutput($retry->stdout."\n".$retry->stderr)) {
                    throw new BridgeHttpException(409, 'The Davis user could not be autocreated.');
                }
                throw new BridgeProtocolException('Unexpected Davis create retry failure.');
            }
            return $this->parseCreatedKey($retry->stdout, $name, $request['login'], $expires);
        }

        return $this->parseCreatedKey($result->stdout, $name, $request['login'], $expires);
    }

    /** Parse a successful create; if Davis made a key we cannot read back, revoke it rather than leave it live. */
    private function parseCreatedKey(string $stdout, string $name, string $login, DateTimeImmutable $expires): array
    {
        try {
            return $this->parseCreateOutput($stdout, $name, $login, $expires);
        } catch (BridgeProtocolException $error) {
            if (preg_match('/\bapp_[a-f0-9]{24}\b/', $this->stripAnsi($stdout), $match)) {
                try {
                    $this->runRevokeCommand($match[0]);
                } catch (Throwable) {
                    // The original protocol error is the one to report; Davis expiry remains the backstop.
                }
            }
            throw $error;
        }
    }

    /** @return list<array<string, mixed>> */
    private function listDavisKeys(): array
    {
        $result = $this->commands->run(['davis:app-key:list']);
        if ($result->exitCode !== 0) {
            throw new BridgeProtocolException('Unexpected Davis list failure.');
        }
        return $this->parseListOutput($result->stdout);
    }

    private function runRevokeCommand(string $appId): void
    {
        $result = $this->commands->run(['davis:app-key:revoke', $appId]);
        if ($result->exitCode !== 0) {
            throw new BridgeProtocolException('Unexpected Davis revoke failure.');
        }
        $output = $this->stripAnsi($result->stdout);
        $allowed = false;
        foreach (preg_split('/\r?\n/', $output) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || preg_match('/\A[-\s]+\z/', $line)) {
                continue;
            }
            if (preg_match('/\A(?:\[OK\]\s+)?Revoked '.preg_quote($appId, '/').'\.\z/', $line)) {
                $allowed = true;
                continue;
            }
            if (preg_match('/\A(?:!\s*)?(?:\[NOTE\]\s+)?'.preg_quote($appId, '/').' was already revoked on \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.\z/', $line)) {
                $allowed = true;
                continue;
            }
            throw new BridgeProtocolException('Unexpected Davis revoke output.');
        }
        if (!$allowed) {
            throw new BridgeProtocolException('Davis revoke output did not identify the requested key.');
        }
    }

    /** @return array<string, mixed> */
    private function parseCreateOutput(string $output, string $expectedName, string $login, DateTimeImmutable $expires): array
    {
        $fields = [];
        foreach (preg_split('/\r?\n/', $this->stripAnsi($output)) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || preg_match('/\A[-\s]+\z/', $line)) {
                continue;
            }
            if (preg_match('/\A(?:!\s*)?(?:\[WARNING\]\s*)?The secret is not stored and will not be shown again\.\z/', $line)) {
                continue;
            }
            if (preg_match('/\A(Name|App id|Secret|Scope|Basic username)\s{2,}(.+)\z/', $line, $match)) {
                if (array_key_exists($match[1], $fields)) {
                    throw new BridgeProtocolException('Duplicate Davis create field.');
                }
                $fields[$match[1]] = trim($match[2]);
                continue;
            }
            throw new BridgeProtocolException('Unexpected Davis create output.');
        }

        foreach (['Name', 'App id', 'Secret', 'Scope', 'Basic username'] as $field) {
            if (!array_key_exists($field, $fields)) {
                throw new BridgeProtocolException('Incomplete Davis create output.');
            }
        }
        if ($fields['Name'] !== $expectedName || $fields['Scope'] !== $login) {
            throw new BridgeProtocolException('Davis create output does not match the requested scope.');
        }
        if (!preg_match('/\Aapp_[a-f0-9]{24}\z/', $fields['App id'])) {
            throw new BridgeProtocolException('Davis returned an invalid app id.');
        }
        if (!preg_match('/\A[a-f0-9]{64}\z/', $fields['Secret'])) {
            throw new BridgeProtocolException('Davis returned an invalid secret.');
        }
        // Davis 5.6.2 prints the login placeholder literally in this
        // definition-list field. The HTTP contract returns the concrete Basic
        // username because the requested scope is already known here. Accept
        // the concrete spelling too so a patched Davis build cannot silently
        // break a valid key response.
        $basicUsername = $login.'*'.$fields['App id'];
        if ($fields['Basic username'] !== '<login>*'.$fields['App id'] && $fields['Basic username'] !== $basicUsername) {
            throw new BridgeProtocolException('Davis returned an invalid basic username.');
        }

        return [
            'app_id' => $fields['App id'],
            'secret' => $fields['Secret'],
            'username' => $basicUsername,
            'expires_at' => $expires->format(DateTimeInterface::ATOM),
        ];
    }

    /** @return list<array<string, mixed>> */
    private function parseListOutput(string $output): array
    {
        $output = $this->stripAnsi($output);
        if (preg_match('/\A(?:!\s*)?(?:\[NOTE\]\s*)?No app key yet\.\z/', trim($output))) {
            return [];
        }

        // Davis 5.6.2 prints a Symfony-style table: dashed border lines with one run of dashes per column, and
        // space-padded cells with no pipes (captured on the live server 2026-10-26). Column starts come from the
        // first border; cells are sliced by character so a human-made key with a non-ASCII name still lines up.
        $columns = ['Name', 'App id', 'Scope', 'Created', 'Last used', 'Used as', 'Status'];
        $starts = null;
        $headerSeen = false;
        $items = [];
        foreach (preg_split('/\r?\n/', $output) ?: [] as $line) {
            $line = rtrim($line);
            if (trim($line) === '') {
                continue;
            }
            if (preg_match('/\A\s*-+(?:\s+-+)+\s*\z/', $line)) {
                if ($starts === null) {
                    preg_match_all('/-+/', $line, $runs, PREG_OFFSET_CAPTURE);
                    $starts = array_map(static fn (array $run): int => $run[1], $runs[0]);
                    if (count($starts) !== count($columns)) {
                        throw new BridgeProtocolException('Unexpected Davis list layout.');
                    }
                }
                continue;
            }
            if ($starts === null) {
                throw new BridgeProtocolException('Unexpected Davis list output.');
            }
            $cells = [];
            foreach ($starts as $index => $offset) {
                $next = $starts[$index + 1] ?? null;
                $cells[] = trim($next === null ? mb_substr($line, $offset) : mb_substr($line, $offset, $next - $offset));
            }
            if (!$headerSeen) {
                if ($cells !== $columns) {
                    throw new BridgeProtocolException('Davis list header was missing.');
                }
                $headerSeen = true;
                continue;
            }
            [$name, $appId, $scopeText, $created, $lastUsed, $usedAs, $status] = $cells;
            $date = '\d{4}-\d{2}-\d{2} \d{2}:\d{2}';
            if ($name === '' || !preg_match('/\Aapp_[a-f0-9]{24}\z/', $appId)
                || !preg_match('/\A'.$date.'\z/', $created)
                || !preg_match('/\A(?:never|'.$date.')\z/', $lastUsed)
                || !preg_match('/\A(?:active|(?:expires|revoked) '.$date.')\z/', $status)) {
                throw new BridgeProtocolException('Unexpected Davis list row.');
            }
            $scope = array_values(array_filter(array_map('trim', explode(',', $scopeText))));
            if ($scope === []) {
                throw new BridgeProtocolException('Davis returned an empty key scope.');
            }
            $items[] = [
                'name' => $name,
                'app_id' => $appId,
                'scope' => $scope,
                'created_at' => $created,
                'last_used_at' => $lastUsed === 'never' ? null : $lastUsed,
                'used_as' => $usedAs,
                'status' => $status,
            ];
        }

        if (!$headerSeen) {
            throw new BridgeProtocolException('Davis list header was missing.');
        }

        return $items;
    }

    private function isUnknownUserOutput(string $output): bool
    {
        // Symfony wraps a long error block onto several lines, so judge the whole message, not one line.
        $text = trim(preg_replace('/\s+/', ' ', $this->stripAnsi($output)) ?? '');
        return (bool) preg_match('/\A(?:\[ERROR\]\s*)?These users do not exist: \S+(?:, \S+)*\.\z/', $text);
    }

    /** @return array<string, mixed> */
    private function decodeBody(string $body): array
    {
        if (strlen($body) > 65_536) {
            throw new BridgeHttpException(413, 'Request body is too large.');
        }
        try {
            $value = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new BridgeHttpException(400, 'Request body must be JSON.');
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new BridgeHttpException(400, 'Request body must be a JSON object.');
        }
        return $value;
    }

    /** @param array<string, string> $headers */
    private function authorize(array $headers, string $callerIp): string
    {
        if (!$this->config->sourceAllowed($callerIp)) {
            throw new BridgeHttpException(403, 'Forbidden source.');
        }
        $authorization = $headers['authorization'] ?? '';
        if (!preg_match('/\ABearer\s+(.+)\z/', trim($authorization), $match)) {
            throw new BridgeHttpException(401, 'Bridge authentication required.');
        }
        $candidate = $match[1];
        if (!hash_equals($this->config->tokenHash, hash('sha256', $candidate))) {
            throw new BridgeHttpException(401, 'Bridge authentication failed.');
        }

        return hash('sha256', $candidate);
    }

    /** @param array<string, string> $headers */
    private function normalizeHeaders(array $headers): array
    {
        $normalized = [];
        foreach ($headers as $key => $value) {
            $normalized[strtolower($key)] = $value;
        }
        return $normalized;
    }

    /** @return array<string, string> */
    private function queryFromPath(string $path): array
    {
        $queryString = parse_url($path, PHP_URL_QUERY);
        if (!is_string($queryString) || $queryString === '') {
            return [];
        }
        parse_str($queryString, $query);
        return array_map(static fn (mixed $value): string => is_string($value) ? $value : '', $query);
    }

    private function now(): DateTimeImmutable
    {
        $clock = $this->clock ?? static fn (): DateTimeImmutable => new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $now = $clock();
        return $now->setTimezone(new DateTimeZone('UTC'));
    }

    private function stripAnsi(string $value): string
    {
        return preg_replace('/\x1b\[[0-9;]*[[:alpha:]]/', '', $value) ?? $value;
    }

    private function audit(
        string $action,
        ?string $login,
        ?string $appId,
        ?string $purpose,
        string $callerIp,
        string $result,
    ): void {
        $line = json_encode([
            'action' => $action,
            'login' => $login,
            'app_id' => $appId,
            'purpose' => $purpose,
            'caller_ip' => $callerIp,
            'result' => $result,
        ], JSON_UNESCAPED_SLASHES);
        if ($line !== false) {
            ($this->auditLogger)('BRIDGE_AUDIT '.$line);
        }
    }
}
