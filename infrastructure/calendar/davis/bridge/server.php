<?php

declare(strict_types=1);

require __DIR__.'/src/BridgeApplication.php';

// The Davis image ships no php.ini, so PHP displays errors. A notice printed before the status line made the dev
// server answer 200 with text ahead of the JSON (seen live 2026-10-26). Log to stderr and drop stray output.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('error_log', 'php://stderr');
ob_start();

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

while (ob_get_level() > 0) {
    ob_end_clean();
}
http_response_code($response->status);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo json_encode($response->body, JSON_UNESCAPED_SLASHES)."\n";
