<?php

declare(strict_types=1);

require __DIR__.'/src/BridgeApplication.php';

try {
    $root = getenv('BRIDGE_DAVIS_ROOT');
    $root = $root === false || trim($root) === '' ? dirname(__DIR__) : rtrim(trim($root), '/');
    $php = getenv('BRIDGE_PHP_BIN');
    $php = $php === false || trim($php) === '' ? PHP_BINARY : trim($php);
    $console = getenv('BRIDGE_CONSOLE');
    $console = $console === false || trim($console) === '' ? $root.'/bin/console' : trim($console);
    $timeout = (int) (getenv('BRIDGE_COMMAND_TIMEOUT_SECONDS') ?: 10);
    $timeout = max(1, min(30, $timeout));

    $config = BridgeConfig::fromEnvironment();
    $runner = new ProcOpenCommandRunner($root, $php, $console, $timeout);
    $provisioner = new DavisUserProvisioner($root, getenv('APP_ENV') ?: 'prod');
    $application = new BridgeApplication(
        $config,
        $runner,
        static fn (string $login): bool => $provisioner->ensure($login),
    );

    $headers = function_exists('getallheaders') ? (getallheaders() ?: []) : [];
    $response = $application->handle(
        $_SERVER['REQUEST_METHOD'] ?? 'GET',
        $_SERVER['REQUEST_URI'] ?? '/',
        $headers,
        file_get_contents('php://input') ?: '',
        $_SERVER['REMOTE_ADDR'] ?? '',
    );
} catch (Throwable) {
    $response = new BridgeHttpResponse(500, ['error' => 'Bridge configuration is unavailable.']);
}

http_response_code($response->status);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo json_encode($response->body, JSON_UNESCAPED_SLASHES)."\n";
