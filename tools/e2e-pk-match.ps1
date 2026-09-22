# E2E verification: free-for-all (PK) match rules  [requirement 27]
#   - both players enter the game -> scene reset (fresh 3:00 timer)
#   - HUD shows countdown + kill target
#   - 10 kills ends the match early
#   - result panel offers "retry (rematch)" + "close room"
#   - retry rebuilds the scene in the SAME room (timer back to 3:00)
# ASCII only (a .ps1 without a BOM would garble non-ASCII literals).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/?server=ws%3A%2F%2F127.0.0.1%3A8799'

function Log($s) { $out.Add($s); Write-Output $s }
function Click($sess, $x, $y) {
  & playwright-cli "-s=$sess" mousemove $x $y 2>&1 | Out-Null
  & playwright-cli "-s=$sess" mousedown 2>&1 | Out-Null
  & playwright-cli "-s=$sess" mouseup 2>&1 | Out-Null
}
function EvalJs($sess, $js) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js.Trim()))
  $r = & playwright-cli "-s=$sess" eval "eval(atob('$b64'))" 2>&1 | ForEach-Object { $_.ToString() }
  return ($r -join ' | ')
}
function RoomCode($sess) {
  $r = & playwright-cli "-s=$sess" eval "(()=>{try{return 'RC='+JSON.parse(localStorage.getItem('yuanqi-warriors:room')||'{}').code}catch(e){return 'RC='}})()" 2>&1 | ForEach-Object { $_.ToString() }
  $m = [regex]::Match(($r -join ' '), 'RC=([A-Z0-9]{4})')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

Log "=== open both sessions ==="
& playwright-cli '-s=hostA' open $U 2>&1 | Out-Null
Start-Sleep -Seconds 4
& playwright-cli '-s=hostA' resize 1280 720 2>&1 | Out-Null
Start-Sleep -Seconds 1

& playwright-cli '-s=guestB' open $U 2>&1 | Out-Null
Start-Sleep -Seconds 4
& playwright-cli '-s=guestB' resize 1280 720 2>&1 | Out-Null
Start-Sleep -Seconds 1

Log "=== host: lobby -> pk -> create ==="
Click 'hostA' 242 439
Start-Sleep -Seconds 3
Click 'hostA' 830 330      # free-for-all card
Start-Sleep -Milliseconds 600
Click 'hostA' 640 448      # create room
$code = ''
foreach ($i in 1..8) { Start-Sleep -Seconds 2; $code = RoomCode 'hostA'; if ($code.Length -eq 4) { break } }
Log ("host room code: [" + $code + "]")
& playwright-cli '-s=hostA' screenshot --filename='.pk-1-lobby.png' 2>&1 | Out-Null

if ($code.Length -ne 4) { Log 'ABORT: no room code'; $out -join "`n" | Set-Content '.pk-e2e-log.txt' -Encoding utf8; exit 1 }

Log "=== guest: lobby -> pk -> join ==="
Click 'guestB' 242 439
Start-Sleep -Seconds 3
Click 'guestB' 830 330
Start-Sleep -Milliseconds 600
Click 'guestB' 640 511      # join room
Start-Sleep -Seconds 2
foreach ($ch in $code.ToCharArray()) {
  $s = [string]$ch
  if ($s -match '^[0-9]$') { $key = 'Digit' + $s } else { $key = 'Key' + $s }
  & playwright-cli '-s=guestB' press $key 2>&1 | Out-Null
  Start-Sleep -Milliseconds 350
}
& playwright-cli '-s=guestB' press Enter 2>&1 | Out-Null
$joined = ''
foreach ($i in 1..8) { Start-Sleep -Seconds 2; $joined = RoomCode 'guestB'; if ($joined.Length -eq 4) { break } }
Log ("guest joined: [" + $joined + "]")

Log "=== host starts the match ==="
Click 'hostA' 640 525      # start expedition
Start-Sleep -Seconds 7
& playwright-cli '-s=hostA' screenshot --filename='.pk-2-inside-a.png' 2>&1 | Out-Null
& playwright-cli '-s=guestB' screenshot --filename='.pk-3-inside-b.png' 2>&1 | Out-Null

# probe the live scene state (both sessions)
$probe = "(()=>{const g=window.__yuanqi&&window.__yuanqi.game;if(!g)return 'NOGAME';return 'MATCH pkTimeLeft='+Number(g.pkTimeLeft).toFixed(1)+' killTarget='+g.pkKillTarget+' ended='+g.ended+' room='+g.roomCode+' overlay='+g.overlayMode})()"
Log ("probeA: " + (EvalJs 'hostA' $probe))
Log ("probeB: " + (EvalJs 'guestB' $probe))

Log "=== force 10 kills on host -> match must end early ==="
$kill = "(()=>{const g=window.__yuanqi&&window.__yuanqi.game;if(!g)return 'NOGAME';g.state.player.kills=10;return 'SET'})()"
Log ("killA: " + (EvalJs 'hostA' $kill))
Start-Sleep -Seconds 3
Log ("probeA2: " + (EvalJs 'hostA' $probe))
Log ("probeB2: " + (EvalJs 'guestB' $probe))
& playwright-cli '-s=hostA' screenshot --filename='.pk-4-result-a.png' 2>&1 | Out-Null
& playwright-cli '-s=guestB' screenshot --filename='.pk-5-result-b.png' 2>&1 | Out-Null

Log "=== host clicks retry (rematch, same room) ==="
Click 'hostA' 640 523
Start-Sleep -Seconds 8
$probe2 = "(()=>{const g=window.__yuanqi&&window.__yuanqi.game;if(!g)return 'NOGAME';return 'AFTER pkTimeLeft='+Number(g.pkTimeLeft).toFixed(1)+' ends='+g.ended+' room='+g.roomCode+' kills='+g.state.player.kills})()"
Log ("rematchA: " + (EvalJs 'hostA' $probe2))
Log ("rematchB: " + (EvalJs 'guestB' $probe2))
& playwright-cli '-s=hostA' screenshot --filename='.pk-6-rematch-a.png' 2>&1 | Out-Null
& playwright-cli '-s=guestB' screenshot --filename='.pk-7-rematch-b.png' 2>&1 | Out-Null

Log "=== close ==="
& playwright-cli '-s=hostA' close 2>&1 | Out-Null
& playwright-cli '-s=guestB' close 2>&1 | Out-Null
$out -join "`n" | Set-Content '.pk-e2e-log.txt' -Encoding utf8
Write-Output 'PK-E2E-DONE'
