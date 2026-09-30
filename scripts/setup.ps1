param(
    [Parameter(Mandatory=$true)][long]$OwnerUserId,
    [string]$RelayUrl = '',
    [string]$PrivateDirectory = $(if ($env:CODEX_TELEGRAM_HOME) { $env:CODEX_TELEGRAM_HOME } else { Join-Path $env:LOCALAPPDATA 'CodexTelegramBridge' })
)
$ErrorActionPreference = 'Stop'
if ($OwnerUserId -le 0) { throw 'OwnerUserId must be a positive Telegram user ID.' }
if ($RelayUrl -and ([uri]$RelayUrl).Scheme -ne 'https') { throw 'RelayUrl must use HTTPS.' }
$PrivateDirectory = [IO.Path]::GetFullPath($PrivateDirectory)
$repoDirectory = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot))
if ($PrivateDirectory -eq $repoDirectory -or $PrivateDirectory.StartsWith($repoDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep private settings outside this repository.'
}
$configPath = Join-Path $PrivateDirectory 'config.json'
if (Test-Path -LiteralPath $configPath) { throw 'Configuration already exists. Edit it directly; setup will not overwrite it.' }
New-Item -ItemType Directory -Path $PrivateDirectory -Force | Out-Null
$token = Read-Host 'Telegram bot token (hidden)' -AsSecureString
$token | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $PrivateDirectory 'bot-token.dpapi') -Encoding ASCII
if ($RelayUrl) {
    $relayKey = Read-Host 'Relay key (hidden; same value as on server)' -AsSecureString
    $relayKey | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $PrivateDirectory 'book-relay-key.dpapi') -Encoding ASCII
}
@{
    ownerUserId = $OwnerUserId
    ownerChatId = $OwnerUserId
    additionalUsers = @()
    initialUpdateOffset = 0
    relayUrl = $RelayUrl
    voiceLanguage = 'ru'
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host "Saved private settings in $PrivateDirectory"
if ($PrivateDirectory -ne (Join-Path $env:LOCALAPPDATA 'CodexTelegramBridge')) {
    Write-Host 'Set CODEX_TELEGRAM_HOME to this directory before starting the bridge.'
}
