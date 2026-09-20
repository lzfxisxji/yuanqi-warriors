# E2E two-browser multiplayer verification v6 (ASCII only)
# Polling instead of fixed sleeps; eval via base64 single-token
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
$U = 'https://lzfxisxji.github.io/yuanqi-warriors/?server=wss%3A%2F%2Fyuanqi-warriors.onrender.com'

$jsHook = @'
(() => { const W = window.WebSocket; const log = []; window.__wslog = log; window.WebSocket = function(u, p) { const ws = (p === undefined) ? new W(u) : new W(u, p); log.push("OPEN " + u); ws.addEventListener("message", function(e) { try { log.push("IN " + String(e.data).slice(0, 600)); } catch (_) {} }); ws.addEventListener("close", function(e) { try { log.push("CLOSE " + e.code + " " + (e.reason || "")); } catch (_) {} }); ws.addEventListener("error", function() { try { log.push("ERR"); } catch (_) {} }); const os = ws.send.bind(ws); ws.send = function(d) { try { log.push("OUT " + String(d).slice(0, 600)); } catch (_) {} return os(d); }; return ws; }; window.WebSocket.prototype = W.prototype; try { window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3; } catch (_) {} return "hooked"; })()
'@

$jsExtract = @'
(() => { const l = window.__wslog || []; const r = l.find(function(x) { return x.indexOf("IN ") === 0 && x.indexOf("created") >= 0; }); if (!r) { return "CODE="; } try { return "CODE=" + JSON.parse(r.substring(3)).code; } catch (e) { return "CODE="; } })()
'@

$jsDump = @'
(function() { return (window.__wslog || []).join(" || "); })()
'@

$jsHasJoined = @'
(() => { const l = window.__wslog || []; return "JOINED=" + (l.some(function(x) { return x.indexOf("IN ") === 0 && x.indexOf("\"t\":\"joined\"") >= 0; }) ? "1" : "0"); })()
'@

function EvalJs($sess, $js) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js.Trim()))
  $arg = "eval(atob('$b64'))"
  $r = & playwright-cli "-s=$sess" eval $arg 2>&1 | ForEach-Object { $_.ToString() }
  return ($r -join ' | ')
}

function Log($s) { $out.Add($s) }

Log "=== STEP 1: hostA open ==="
$rc = & playwright-cli '-s=hostA' open $U 2>&1 | ForEach-Object { $_.ToString() }
Log ("openA: " + (($rc | Select-Object -First 1) -join ' | '))
Start-Sleep -Seconds 4
$rc = & playwright-cli '-s=hostA' resize 1280 720 2>&1 | ForEach-Object { $_.ToString() }
Log "resizeA ok"
Start-Sleep -Seconds 1
$rc = EvalJs 'hostA' $jsHook
Log ("hookA: " + (($rc -split ' \| ')[0]))

Log "=== STEP 2: hostA click multi + create ==="
& playwright-cli '-s=hostA' mousemove 242 439 2>&1 | Out-Null
& playwright-cli '-s=hostA' mousedown 2>&1 | Out-Null
& playwright-cli '-s=hostA' mouseup 2>&1 | Out-Null
Log "clickMultiA sent"
Start-Sleep -Seconds 3
& playwright-cli '-s=hostA' mousemove 640 448 2>&1 | Out-Null
& playwright-cli '-s=hostA' mousedown 2>&1 | Out-Null
& playwright-cli '-s=hostA' mouseup 2>&1 | Out-Null
Log "clickCreateA sent"

Log "=== STEP 3: poll room code (up to 24s) ==="
$code = ''
foreach ($i in 1..12) {
  Start-Sleep -Seconds 2
  $raw = EvalJs 'hostA' $jsExtract
  $mm = [regex]::Match($raw, 'CODE=([A-Z0-9]{4})')
  if ($mm.Success) { $code = $mm.Groups[1].Value; break }
}
Log ("code: [" + $code + "] after poll")
& playwright-cli '-s=hostA' screenshot --filename='.shot-a2.png' 2>&1 | Out-Null
Log "shotA2 saved"

if ($code.Length -eq 4) {
  Log "=== STEP 4: guestB open + join ==="
  $rc = & playwright-cli '-s=guestB' open $U 2>&1 | ForEach-Object { $_.ToString() }
  Log ("openB: " + (($rc | Select-Object -First 1) -join ' | '))
  Start-Sleep -Seconds 4
  $rc = & playwright-cli '-s=guestB' resize 1280 720 2>&1 | ForEach-Object { $_.ToString() }
  Log "resizeB ok"
  Start-Sleep -Seconds 1
  $rc = EvalJs 'guestB' $jsHook
  Log ("hookB: " + (($rc -split ' \| ')[0]))
  & playwright-cli '-s=guestB' mousemove 242 439 2>&1 | Out-Null
  & playwright-cli '-s=guestB' mousedown 2>&1 | Out-Null
  & playwright-cli '-s=guestB' mouseup 2>&1 | Out-Null
  Log "clickMultiB sent"
  Start-Sleep -Seconds 3
  & playwright-cli '-s=guestB' mousemove 640 511 2>&1 | Out-Null
  & playwright-cli '-s=guestB' mousedown 2>&1 | Out-Null
  & playwright-cli '-s=guestB' mouseup 2>&1 | Out-Null
  Log "clickJoinB sent"
  Start-Sleep -Seconds 2

  Log "=== STEP 5: type room code + Enter ==="
  foreach ($ch in $code.ToCharArray()) {
    $s = [string]$ch
    if ($s -match '^[0-9]$') { $key = 'Digit' + $s } else { $key = 'Key' + $s }
    & playwright-cli '-s=guestB' press $key 2>&1 | Out-Null
    Log ("press " + $key)
    Start-Sleep -Milliseconds 400
  }
  & playwright-cli '-s=guestB' press Enter 2>&1 | Out-Null
  Log "press Enter (confirm join)"

  Log "=== STEP 5b: poll guest joined (up to 20s) ==="
  $joined = '0'
  foreach ($i in 1..10) {
    Start-Sleep -Seconds 2
    $raw = EvalJs 'guestB' $jsHasJoined
    if ($raw -match 'JOINED=1') { $joined = '1'; break }
  }
  Log ("guestJoined: " + $joined)

  Log "=== STEP 6: screenshots both ==="
  & playwright-cli '-s=guestB' screenshot --filename='.shot-b1.png' 2>&1 | Out-Null
  Log "shotB1 saved"
  & playwright-cli '-s=hostA' screenshot --filename='.shot-a3.png' 2>&1 | Out-Null
  Log "shotA3 saved"

  Log "=== STEP 7: wslog dumps (lobby stage) ==="
  $rc = EvalJs 'hostA' $jsDump
  Log ("wslogA-lobby: " + $rc)
  $rc = EvalJs 'guestB' $jsDump
  Log ("wslogB-lobby: " + $rc)

  if ($joined -eq '1') {
    Log "=== STEP 8: host starts expedition ==="
    & playwright-cli '-s=hostA' mousemove 640 525 2>&1 | Out-Null
    & playwright-cli '-s=hostA' mousedown 2>&1 | Out-Null
    & playwright-cli '-s=hostA' mouseup 2>&1 | Out-Null
    Log "clickStartA sent"
    Start-Sleep -Seconds 6
    & playwright-cli '-s=hostA' screenshot --filename='.shot-a4.png' 2>&1 | Out-Null
    Log "shotA4 saved"
    & playwright-cli '-s=guestB' screenshot --filename='.shot-b2.png' 2>&1 | Out-Null
    Log "shotB2 saved"

    Log "=== STEP 9: wslog dumps (post-start) ==="
    $rc = EvalJs 'hostA' $jsDump
    Log ("wslogA-final: " + $rc)
    $rc = EvalJs 'guestB' $jsDump
    Log ("wslogB-final: " + $rc)
  } else {
    Log "SKIP start: guest did not join"
  }
} else {
  Log "SKIP: code extraction failed, guest stage aborted"
}

Log "=== STEP 10: close ==="
& playwright-cli '-s=hostA' close 2>&1 | Out-Null
& playwright-cli '-s=guestB' close 2>&1 | Out-Null
Log "both closed"

$out -join "`n" | Set-Content '.e2e-log.txt' -Encoding utf8
Write-Output "E2E-DONE"
