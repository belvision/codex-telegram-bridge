<?php
require_once __DIR__ . '/../core/bootstrap.php';
// Telegram pushes Codex bot updates here. The desktop bridge still reads its
// durable relay queue; no long-running PHP worker is needed.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo '{"ok":false}'; exit; }

$secretFile = bridge_private_dir() . '/webhook-secret';
$expected = is_file($secretFile) ? trim(file_get_contents($secretFile)) : '';
$provided = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
if ($expected === '' || !is_string($provided) || !hash_equals($expected, $provided)) {
    http_response_code(403); echo '{"ok":false}'; exit;
}
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 1048576) { http_response_code(413); echo '{"ok":false}'; exit; }
$update = json_decode(file_get_contents('php://input', false, null, 0, 1048577), true);
if (!is_array($update) || !isset($update['update_id']) || !is_int($update['update_id']) || $update['update_id'] < 0) {
    http_response_code(400); echo '{"ok":false}'; exit;
}


$lock = fopen(bridge_private_dir() . '/webhook.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX)) { http_response_code(503); echo '{"ok":false}'; exit; }
try {
    $telegram = new BookTelegram();
    $telegram->ingest($update);
    $service = new Community();
    if ($service->state('relay_cleanup_day', '') !== date('Y-m-d')) {
        $service->query('DELETE FROM book_telegram_relay WHERE acked_at<DATE_SUB(NOW(),INTERVAL 7 DAY)');
        $service->setState('relay_cleanup_day', date('Y-m-d'));
    }
    $service->query("UPDATE book_telegram_outbox SET status='pending' WHERE status='sending'");
    $telegram->flush(3);
    echo '{"ok":true}';
} catch (Throwable $error) {
    http_response_code(503);
    echo '{"ok":false}';
    error_log('codex-telegram-webhook-failed code=' . (int)$error->getCode());
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
