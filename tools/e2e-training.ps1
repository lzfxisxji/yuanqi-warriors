# E2E verification: training camp  [requirement 29]
#   - main menu has a "training camp" entry next to "online"
#   - the training page lets you pick ANY character / ANY weapon (no locks)
#   - entering the camp spawns one infinite-HP immobile dummy, room is sealed
#   - Niu Lai's dash really deals 42 damage to the dummy
#   - Esc opens the training-specific pause panel (3 exits only)
# ASCII only (a .ps1 without a BOM would garble non-ASCII literals).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'

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

$S = 'trainS'

Log "=== open ==="
& playwright-cli "-s=$S" open $U 2>&1 | Out-Null
Start-Sleep -Seconds 4
& playwright-cli "-s=$S" resize 1280 720 2>&1 | Out-Null
Start-Sleep -Seconds 1
& playwright-cli "-s=$S" screenshot --filename='.tr-1-menu.png' 2>&1 | Out-Null

Log "=== main menu: click TRAINING button (246..392 x 416..462) ==="
Click $S 319 439
Start-Sleep -Seconds 1
$mode = "(()=>{const a=window.__yuanqi;return 'MODE='+a.menuState.mode})()"
Log ("afterClick: " + (EvalJs $S $mode))
& playwright-cli "-s=$S" screenshot --filename='.tr-2-page.png' 2>&1 | Out-Null

Log "=== pick an unlocked-by-default weapon (slot 1) + a different character (slot 4) ==="
Click $S 362 327       # train-weapon:1  (row0 card1)
Start-Sleep -Milliseconds 500
Click $S 914 188       # train-char:4    (Milk Dragon)
Start-Sleep -Milliseconds 500
$pick = "(()=>{const s=window.__yuanqi.menuState;return 'PICK char='+s.trainingChar+' weapon='+s.trainingWeapon})()"
Log ("pick: " + (EvalJs $S $pick))
& playwright-cli "-s=$S" screenshot --filename='.tr-3-picked.png' 2>&1 | Out-Null

Log "=== start training ==="
Click $S 640 513
Start-Sleep -Seconds 3
$probe = "(()=>{const g=window.__yuanqi.game;if(!g)return 'NOGAME';const d=g.trainingDummy;return 'TRAIN isTraining='+g.isTraining+' weapon='+g.state.player.currentWeapon.def.id+' dummy='+(d?('yes hp='+d.hp+'/'+d.maxHp+' immobile='+d.def.immobile+' infinite='+d.def.infiniteHp+' x='+Math.round(d.x)+' y='+Math.round(d.y)):'none')+' overlay='+g.overlayMode})()"
Log ("probe: " + (EvalJs $S $probe))
& playwright-cli "-s=$S" screenshot --filename='.tr-4-inside.png' 2>&1 | Out-Null

Log "=== dash into the dummy (Niu Lai is char slot 5; switch via a fresh camp) ==="
# reload and pick Niu Lai so the dash has damage
& playwright-cli "-s=$S" reload 2>&1 | Out-Null
Start-Sleep -Seconds 4
Click $S 319 439        # training entry
Start-Sleep -Seconds 1
Click $S 1098 188       # train-char:5 (Niu Lai)
Start-Sleep -Milliseconds 400
Click $S 178 327        # train-weapon:0
Start-Sleep -Milliseconds 400
$pick2 = "(()=>{const s=window.__yuanqi.menuState;return 'PICK2 char='+s.trainingChar+' weapon='+s.trainingWeapon})()"
Log ("pick2: " + (EvalJs $S $pick2))
Click $S 640 513        # start
Start-Sleep -Seconds 3

$before = "(()=>{const g=window.__yuanqi.game;if(!g)return 'NOGAME';const d=g.trainingDummy;return 'BEFORE dmg='+d.damageTaken+' hp='+d.hp})()"
Log ("before: " + (EvalJs $S $before))

$dash = "(()=>{const g=window.__yuanqi.game;const d=g.trainingDummy;const p=g.state.player;p.x=d.x-40;p.y=d.y;p.moving=false;p.aimAngle=0;p.vx=0;p.vy=0;const ok=p.useSkill();return 'DASH ok='+ok+' dashTimer='+Number(p.dashTimer).toFixed(2)})()"
Log ("dash: " + (EvalJs $S $dash))
Start-Sleep -Milliseconds 900
$after = "(()=>{const g=window.__yuanqi.game;const d=g.trainingDummy;const p=g.state.player;return 'AFTER dmg='+d.damageTaken+' hp='+d.hp+'/'+d.maxHp+' dead='+d.dead+' dashTimer='+Number(p.dashTimer).toFixed(2)})()"
Log ("after: " + (EvalJs $S $after))
& playwright-cli "-s=$S" screenshot --filename='.tr-5-dash.png' 2>&1 | Out-Null

Log "=== press Escape -> training pause panel ==="
& playwright-cli "-s=$S" press Escape 2>&1 | Out-Null
Start-Sleep -Seconds 1
$pause = "(()=>{const g=window.__yuanqi.game;return 'PAUSE overlay='+g.overlayMode+' buttons='+g.overlayButtonIds.join(',')})()"
Log ("pause: " + (EvalJs $S $pause))
& playwright-cli "-s=$S" screenshot --filename='.tr-6-pause.png' 2>&1 | Out-Null

Log "=== no save file must have been written ==="
$save = "(()=>{const a=window.__yuanqi;return 'RUNS='+a.menuState.saves.length+' raw='+(localStorage.getItem('yuanqi-warriors:save:v1')||'').length})()"
Log ("save: " + (EvalJs $S $save))

& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content '.tr-e2e-log.txt' -Encoding utf8
Write-Output 'TRAIN-E2E-DONE'
