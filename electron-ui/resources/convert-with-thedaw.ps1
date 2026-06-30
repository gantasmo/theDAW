# theDAW — Explorer right-click convert helper.
#
# Invoked by the per-user "Convert with theDAW" context menu (registered in
# installer.nsh). Converts a single file to the chosen format using the ffmpeg
# bundled beside this script (resources\tools\ffmpeg.exe), writes the result next
# to the source, and reveals it in Explorer. Mirrors the in-app /api/convert args.
param(
    [Parameter(Mandatory = $true)][string]$Format,
    [Parameter(Mandatory = $true)][string]$Source
)

$ErrorActionPreference = 'Stop'

function Show-Error([string]$message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [System.Windows.Forms.MessageBox]::Show($message, 'theDAW Convert', 'OK', 'Error') | Out-Null
    } catch {
        Write-Host $message
    }
    exit 1
}

$ffmpeg = Join-Path $PSScriptRoot 'tools\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpeg)) { Show-Error "ffmpeg was not found at $ffmpeg" }
if (-not (Test-Path -LiteralPath $Source)) { Show-Error "Source file not found: $Source" }

$ext = $Format.ToLowerInvariant()
$dir = Split-Path -Parent $Source
$base = [System.IO.Path]::GetFileNameWithoutExtension($Source)
$out = Join-Path $dir "$base.$ext"
$n = 1
while (Test-Path -LiteralPath $out) { $out = Join-Path $dir "$base ($n).$ext"; $n++ }

# Format-specific encoder args (kept in step with backend/modules/convert/router.py).
$ffArgs = @('-hide_banner', '-loglevel', 'error', '-y', '-i', $Source)
switch ($ext) {
    'wav'  { $ffArgs += @('-c:a', 'pcm_s16le') }
    'mp3'  { $ffArgs += @('-c:a', 'libmp3lame', '-q:a', '2', '-vn') }
    'flac' { $ffArgs += @('-c:a', 'flac', '-vn') }
    'ogg'  { $ffArgs += @('-c:a', 'libvorbis', '-q:a', '5', '-vn') }
    'm4a'  { $ffArgs += @('-c:a', 'aac', '-b:a', '256k', '-vn') }
    'mp4'  { $ffArgs += @('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '192k') }
    'mov'  { $ffArgs += @('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '192k') }
    'webm' { $ffArgs += @('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus') }
    'gif'  { $ffArgs += @('-vf', 'fps=12,scale=480:-1:flags=lanczos') }
    'png'  { $ffArgs += @('-frames:v', '1') }
    'jpg'  { $ffArgs += @('-frames:v', '1', '-q:v', '3') }
    'webp' { $ffArgs += @('-frames:v', '1') }
    default { Show-Error "Unsupported target format: $ext" }
}
$ffArgs += $out

try {
    $proc = Start-Process -FilePath $ffmpeg -ArgumentList $ffArgs -NoNewWindow -Wait -PassThru
} catch {
    Show-Error "Could not run ffmpeg: $($_.Exception.Message)"
}

if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $out)) {
    Show-Error "Conversion to $ext failed (ffmpeg exit $($proc.ExitCode))."
}

# Reveal the converted file in Explorer.
Start-Process explorer.exe "/select,`"$out`""
