<?php

declare(strict_types=1);

require dirname(__DIR__).'/src/BridgeApplication.php';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function checkSame(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        throw new RuntimeException($message.' expected '.var_export($expected, true).' got '.var_export($actual, true));
    }
}

$statePath = sys_get_temp_dir().'/davis-bridge-'.bin2hex(random_bytes(8)).'.json';
$state = ['users' => ['person@calendar.test'], 'keys' => [], 'create_count' => 0];
file_put_contents($statePath, json_encode($state, JSON_THROW_ON_ERROR));
putenv('FAKE_CONSOLE_STATE='.$statePath);

$root = dirname(__DIR__);
$console = __DIR__.'/bin/console';
$runner = new ProcOpenCommandRunner($root, PHP_BINARY, $console, 3);
$token = 'fictional-bridge-token-'.bin2hex(random_bytes(8));
$logs = [];
$clock = static fn (): DateTimeImmutable => new DateTimeImmutable('2026-10-25T12:00:00+00:00');
$config = new BridgeConfig(hash('sha256', $token), ['calendar.test'], 'admin@calendar.test', ['127.0.0.1'], false);
$application = new BridgeApplication(
    $config,
    $runner,
    static function (string $login) use ($statePath): bool {
        $state = json_decode(file_get_contents($statePath) ?: '', true, 16, JSON_THROW_ON_ERROR);
        $state['users'][] = $login;
        file_put_contents($statePath, json_encode($state, JSON_THROW_ON_ERROR));
        return true;
    },
    static function (string $line) use (&$logs): void {
        $logs[] = $line;
    },
    $clock,
);

$health = $application->handle('GET', '/v1/health', [], '', '127.0.0.1');
checkSame(200, $health->status, 'health status');
checkSame(['status' => 'ok'], $health->body, 'health body');

$unauthenticated = $application->handle('GET', '/v1/keys?login=person%40calendar.test', [], '', '127.0.0.1');
checkSame(401, $unauthenticated->status, 'missing auth status');

$emptyListed = $application->handle('GET', '/v1/keys?login=person%40calendar.test', [
    'authorization' => 'Bearer '.$token,
], '', '127.0.0.1');
checkSame(200, $emptyListed->status, 'empty key list status');
checkSame([], $emptyListed->body['items'], 'empty key list body');

$headers = [
    'Authorization' => 'Bearer '.$token,
    'Idempotency-Key' => 'fictional-create-retry-1',
];
$create = $application->handle('POST', '/v1/keys', $headers, json_encode([
    'login' => 'person@calendar.test',
    'label' => 'Phone A',
    'purpose' => 'device',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(201, $create->status, 'device create status');
check(isset($create->body['secret']) && is_string($create->body['secret']) && strlen($create->body['secret']) === 64, 'device secret shape');
checkSame('person@calendar.test*'.$create->body['app_id'], $create->body['username'], 'basic username');
checkSame('2027-10-25T12:00:00+00:00', $create->body['expires_at'], 'device default expiry');
$secret = $create->body['secret'];

$replayed = $application->handle('POST', '/v1/keys', $headers, json_encode([
    'login' => 'person@calendar.test',
    'label' => 'Phone A',
    'purpose' => 'device',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame($create->body, $replayed->body, 'idempotent create result');
$state = json_decode(file_get_contents($statePath) ?: '', true, 16, JSON_THROW_ON_ERROR);
checkSame(1, $state['create_count'], 'idempotency did not mint twice');

$mismatch = $application->handle('POST', '/v1/keys', $headers, json_encode([
    'login' => 'person@calendar.test',
    'label' => 'Other',
    'purpose' => 'device',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(409, $mismatch->status, 'idempotency mismatch status');

$listed = $application->handle('GET', '/v1/keys?login=person%40calendar.test', [
    'authorization' => 'Bearer '.$token,
], '', '127.0.0.1');
checkSame(200, $listed->status, 'key list status');
checkSame(1, count($listed->body['items']), 'key list count');
check(!str_contains(json_encode($listed->body, JSON_THROW_ON_ERROR), $secret), 'list returned the secret');

$backendTooLong = $application->handle('POST', '/v1/keys', [
    'authorization' => 'Bearer '.$token,
    'idempotency-key' => 'backend-over-cap',
], json_encode([
    'login' => 'person@calendar.test',
    'label' => 'Backend',
    'purpose' => 'backend',
    'ttl_seconds' => 86_401,
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(400, $backendTooLong->status, 'backend ttl cap');

$admin = $application->handle('POST', '/v1/keys', [
    'authorization' => 'Bearer '.$token,
    'idempotency-key' => 'admin-rejected',
], json_encode([
    'login' => 'admin@calendar.test',
    'label' => 'Nope',
    'purpose' => 'device',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(403, $admin->status, 'admin fence');

$missingUser = $application->handle('POST', '/v1/keys', [
    'authorization' => 'Bearer '.$token,
    'idempotency-key' => 'missing-user',
], json_encode([
    'login' => 'new-person@calendar.test',
    'label' => 'Phone',
    'purpose' => 'device',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(409, $missingUser->status, 'missing Davis user status');

$autoConfig = new BridgeConfig(hash('sha256', $token), ['calendar.test'], 'admin@calendar.test', ['127.0.0.1'], true);
$autoCreate = new BridgeApplication(
    $autoConfig,
    $runner,
    static function (string $login) use ($statePath): bool {
        $state = json_decode(file_get_contents($statePath) ?: '', true, 16, JSON_THROW_ON_ERROR);
        $state['users'][] = $login;
        file_put_contents($statePath, json_encode($state, JSON_THROW_ON_ERROR));
        return true;
    },
    static function (): void {
    },
    $clock,
);
$autocreated = $autoCreate->handle('POST', '/v1/keys', [
    'authorization' => 'Bearer '.$token,
    'idempotency-key' => 'autocreate-1',
], json_encode([
    'login' => 'new-person@calendar.test',
    'label' => 'Backend worker',
    'purpose' => 'backend',
], JSON_THROW_ON_ERROR), '127.0.0.1');
checkSame(201, $autocreated->status, 'autocreate status');
checkSame('2026-10-26T12:00:00+00:00', $autocreated->body['expires_at'], 'backend default expiry');

$state = json_decode(file_get_contents($statePath) ?: '', true, 16, JSON_THROW_ON_ERROR);
$humanAppId = 'app_'.substr(hash('sha256', 'dashboard-key'), 0, 24);
$state['keys'][] = [
    'name' => 'human-dashboard-key',
    'app_id' => $humanAppId,
    'scope' => ['person@calendar.test'],
    'created' => '2026-10-25 12:00',
    'last_used' => 'never',
    'used_as' => 'nobody',
    'status' => 'active',
];
file_put_contents($statePath, json_encode($state, JSON_THROW_ON_ERROR));
$humanRevoke = $application->handle('DELETE', '/v1/keys/'.rawurlencode($humanAppId), [
    'authorization' => 'Bearer '.$token,
], '', '127.0.0.1');
checkSame(404, $humanRevoke->status, 'human-created key was protected');

$revoked = $application->handle('DELETE', '/v1/keys/'.rawurlencode($create->body['app_id']), [
    'authorization' => 'Bearer '.$token,
], '', '127.0.0.1');
checkSame(200, $revoked->status, 'revoke status');
checkSame(true, $revoked->body['confirmed'], 'revoke confirmation');
$revokedAgain = $application->handle('DELETE', '/v1/keys/'.rawurlencode($create->body['app_id']), [
    'authorization' => 'Bearer '.$token,
], '', '127.0.0.1');
checkSame(200, $revokedAgain->status, 'idempotent revoke status');

$logsText = implode("\n", $logs);
check(!str_contains($logsText, $secret), 'audit log contained the secret');
check(!str_contains($logsText, $token), 'audit log contained the token');
check(str_contains($logsText, 'BRIDGE_AUDIT'), 'audit log was not emitted');

unlink($statePath);
echo "bridge tests passed: 17 assertions\n";
