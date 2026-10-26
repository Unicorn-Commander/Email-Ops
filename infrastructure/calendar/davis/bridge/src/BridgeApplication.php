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
            if ($kernel !== null && method_exists($kernel, 'shutdown')) {
                $kernel->shutdown();
            }
        }
    }

    private function bootKernel(): object
    {
        $runtimeAutoload = $this->root.'/vendor/autoload_runtime.php';
        $autoload = $this->root.'/vendor/autoload.php';
        if (is_file($runtimeAutoload)) {
            require_once $runtimeAutoload;
        } elseif (is_file($autoload)) {
            require_once $autoload;
        } else {
            throw new RuntimeException('Davis autoloader is unavailable.');
        }

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
    private const IDEMPOTENCY_WINDOW = 600;

    /** @var array<string, array{fingerprint: string, expires_at: int, result: array<string, mixed>}> */
    private array $idempotency = [];

    /** @var callable(string): bool */
    private $ensureUser;

    /** @var callable(string): void */
    private $auditLogger;

    /** @var callable(): DateTimeImmutable|null */
    private $clock;

    /** @param callable(string): void|null $auditLogger */
    public function __construct(
        private readonly BridgeConfig $config,
        private readonly BridgeCommandRunner $commands,
        callable $ensureUser,
        ?callable $auditLogger = null,
        ?callable $clock = null,
    ) {
        $this->ensureUser = $ensureUser;
        $this->clock = $clock;
        $this->auditLogger = $auditLogger ?? static fn (string $line): bool => error_log($line);
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
            $this->authorize($headers, $callerIp);

            if ($method === 'POST' && $route === '/v1/keys') {
                return $this->create($headers, $body, $callerIp);
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
    private function create(array $headers, string $body, string $callerIp): BridgeHttpResponse
    {
        $input = $this->decodeBody($body);
        $request = $this->validateCreate($input);
        $idempotencyKey = $headers['idempotency-key'] ?? '';
        if ($idempotencyKey === '' || strlen($idempotencyKey) > 200 || !preg_match('/\A[\x20-\x7e]+\z/', $idempotencyKey)) {
            throw new BridgeHttpException(400, 'Idempotency-Key is required and must be printable.');
        }

        $this->purgeIdempotency();
        $fingerprint = hash('sha256', json_encode($request, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        $cached = $this->idempotency[$idempotencyKey] ?? null;
        if ($cached !== null) {
            if (!hash_equals($cached['fingerprint'], $fingerprint)) {
                throw new BridgeHttpException(409, 'Idempotency-Key was already used for another request.');
            }
            $this->audit('create', $request['login'], $cached['result']['app_id'] ?? null, $request['purpose'], $callerIp, 'replayed');
            return new BridgeHttpResponse(201, $cached['result']);
        }

        try {
            $result = $this->createDavisKey($request);
            $this->idempotency[$idempotencyKey] = [
                'fingerprint' => $fingerprint,
                'expires_at' => time() + self::IDEMPOTENCY_WINDOW,
                'result' => $result,
            ];
            $this->audit('create', $request['login'], $result['app_id'], $request['purpose'], $callerIp, 'created');
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
        if (!is_string($label) || $label === '' || strlen($label) > 64 || !preg_match('/\A[\x20-\x7e]+\z/', $label)) {
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
            return $this->parseCreateOutput($retry->stdout, $name, $request['login'], $expires);
        }

        return $this->parseCreateOutput($result->stdout, $name, $request['login'], $expires);
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
            if ($line === '' || preg_match('/\A[-+]+\z/', $line)) {
                continue;
            }
            if (preg_match('/\A(?:\[OK\]\s+)?Revoked '.preg_quote($appId, '/').'\.\z/', $line)) {
                $allowed = true;
                continue;
            }
            if (preg_match('/\A(?:\[NOTE\]\s+)?'.preg_quote($appId, '/').' was already revoked on \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.\z/', $line)) {
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
            if ($line === '' || preg_match('/\A[-+]+\z/', $line)) {
                continue;
            }
            if (preg_match('/\A!.*The secret is not stored and will not be shown again\.\z/', $line)) {
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
        if (preg_match('/\A(?:\[NOTE\]\s*)?No app key yet\.\z/', trim($output))) {
            return [];
        }

        $headerSeen = false;
        $items = [];
        foreach (preg_split('/\r?\n/', $output) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || preg_match('/\A[+\-]+\z/', $line)) {
                continue;
            }
            if (preg_match('/\A\|\s*Name\s*\|\s*App id\s*\|\s*Scope\s*\|\s*Created\s*\|\s*Last used\s*\|\s*Used as\s*\|\s*Status\s*\|\z/', $line)) {
                if ($headerSeen) {
                    throw new BridgeProtocolException('Duplicate Davis list header.');
                }
                $headerSeen = true;
                continue;
            }
            if (preg_match('/\A\|\s*(.*?)\s*\|\s*(app_[a-f0-9]{24})\s*\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\|\s*(never|\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\|\s*(.*?)\s*\|\s*(active|expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}|revoked \d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\|\z/', $line, $match)) {
                if (!$headerSeen || $match[1] === '') {
                    throw new BridgeProtocolException('Davis list row appeared before its header.');
                }
                $scope = array_values(array_filter(array_map('trim', explode(',', $match[3]))));
                if ($scope === []) {
                    throw new BridgeProtocolException('Davis returned an empty key scope.');
                }
                $items[] = [
                    'name' => $match[1],
                    'app_id' => $match[2],
                    'scope' => $scope,
                    'created_at' => $match[4],
                    'last_used_at' => $match[5] === 'never' ? null : $match[5],
                    'used_as' => $match[6],
                    'status' => $match[7],
                ];
                continue;
            }
            throw new BridgeProtocolException('Unexpected Davis list output.');
        }

        if (!$headerSeen) {
            throw new BridgeProtocolException('Davis list header was missing.');
        }
        return $items;
    }

    private function isUnknownUserOutput(string $output): bool
    {
        $lines = array_values(array_filter(array_map('trim', preg_split('/\r?\n/', $this->stripAnsi($output)) ?: [])));
        return count($lines) === 1 && (bool) preg_match('/\A(?:\[ERROR\]\s*)?These users do not exist: .+\.\z/', $lines[0]);
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
    private function authorize(array $headers, string $callerIp): void
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

    private function purgeIdempotency(): void
    {
        $now = time();
        foreach ($this->idempotency as $key => $entry) {
            if ($entry['expires_at'] <= $now) {
                unset($this->idempotency[$key]);
            }
        }
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
