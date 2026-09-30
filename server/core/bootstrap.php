<?php
function bridge_private_dir()
{
    $dir = getenv('CODEX_TELEGRAM_PRIVATE_DIR');
    if (!$dir || !is_dir($dir)) { throw new RuntimeException('private-directory-required'); }
    $resolved = realpath($dir);
    $public = realpath(__DIR__ . '/../public');
    if ($resolved === $public || strpos($resolved, $public . DIRECTORY_SEPARATOR) === 0) {
        throw new RuntimeException('private-directory-must-be-outside-public');
    }
    return $resolved;
}
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/Community.php';
require_once __DIR__ . '/BookTelegram.php';
