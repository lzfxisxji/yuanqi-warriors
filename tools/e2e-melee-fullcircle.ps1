# E2E verification: melee charge = 360 degree full-circle (requirement 31)
# ASCII only (no BOM). Drives real input path via playwright mouse hold/release.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'
$S = 'fcS'

function Log($s) { $out.Add($s); Write-Output $s }
function EvalJs($js) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js.Trim()))
  $r = & playwright-cli "-s=$S" eval "eval(atob('$b64'))" 2>&1 | ForEach-Object { $_.ToString() }
  return ($r -join ' | ')
}

Log "=== open ==="
& playwright-cli "-s=$S" open $U 2>&1 | Out-Null
Start-Sleep -Seconds 4
& playwright-cli "-s=$S" resize 1280 720 2>&1 | Out-Null
Start-Sleep -Seconds 1

Log "=== enter training with a melee weapon ==="
$start = "(()=>{const app=window.__yuanqi;let mi=-1;for(let i=0;i<24;i++){app.menuState.trainingWeapon=i;app.menuState.trainingChar=0;app.startTraining();const g=app.game;if(g&&g.run&&g.run.player.currentWeapon.def.kind==='melee'){mi=i;break;}}const g=app.game;const p=g.run.player;p.currentWeapon.def.crit=0;const d=g.trainingDummy;return JSON.stringify({meleeIdx:mi,kind:p.currentWeapon.def.kind,name:p.currentWeapon.def.name,base:p.currentWeapon.def.damage,dummy:!!d});})()"
Log ("START " + (EvalJs $start))

# place player just BELOW the dummy; dummy is above the player.
$place = "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.x=d.x;p.y=d.y+55;p.currentWeapon.def.crit=0;p.aimAngle=0;return JSON.stringify({dmg0:d.damageTaken});})()"
Log ("PLACED " + (EvalJs $place))
Start-Sleep -Milliseconds 350

Log "=== PHASE A: aim TOWARD dummy (up), charge 1.5s -> should hit (control) ==="
& playwright-cli "-s=$S" mousemove 640 240 2>&1 | Out-Null
Start-Sleep -Milliseconds 350
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 1500
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 200
Log ("A_TOWARD " + (EvalJs "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.currentWeapon.def.crit=0;return 'dmg='+d.damageTaken+' swing='+p.meleeSwingFullCircle;})()"))
Start-Sleep -Milliseconds 900

Log "=== PHASE B: aim AWAY from dummy (down), TAP -> fan should MISS (no damage) ==="
$place = "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.x=d.x;p.y=d.y+55;p.currentWeapon.def.crit=0;return JSON.stringify({before:d.damageTaken});})()"
Log ("B_PLACE " + (EvalJs $place))
& playwright-cli "-s=$S" mousemove 640 480 2>&1 | Out-Null
Start-Sleep -Milliseconds 350
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 90
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 200
Log ("B_AWAY_TAP " + (EvalJs "(()=>{const g=window.__yuanqi.game,d=g.trainingDummy;return 'dmg='+d.damageTaken;})()"))
Start-Sleep -Milliseconds 900

Log "=== PHASE C: aim AWAY from dummy (down), CHARGE 1.5s -> full-circle SHOULD hit ==="
$place = "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.x=d.x;p.y=d.y+55;p.currentWeapon.def.crit=0;return JSON.stringify({before:d.damageTaken});})()"
Log ("C_PLACE " + (EvalJs $place))
& playwright-cli "-s=$S" mousemove 640 480 2>&1 | Out-Null
Start-Sleep -Milliseconds 350
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 1500
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 200
Log ("C_AWAY_CHARGE " + (EvalJs "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;return 'dmg='+d.damageTaken+' swing='+p.meleeSwingFullCircle;})()"))
& playwright-cli "-s=$S" screenshot --filename='.fc-inside.png' 2>&1 | Out-Null

& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content 'fc_e2e.txt' -Encoding utf8
Write-Output 'FULLCIRCLE-E2E-DONE'
