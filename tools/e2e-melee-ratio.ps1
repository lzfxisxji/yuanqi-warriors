# Precise melee charge multiplier check: pin meleeCharge, bypass mouse-hold timing.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'
$S = 'mchR'

function Log($s) { $out.Add($s); Write-Output $s }
function EvalJs($js) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js.Trim()))
  $r = & playwright-cli "-s=$S" eval "eval(atob('$b64'))" 2>&1 | ForEach-Object { $_.ToString() }
  return ($r -join ' | ')
}

& playwright-cli "-s=$S" open $U 2>&1 | Out-Null
Start-Sleep -Seconds 4
& playwright-cli "-s=$S" resize 1280 720 2>&1 | Out-Null
Start-Sleep -Seconds 1

$start = "(()=>{const app=window.__yuanqi;let mi=-1;for(let i=0;i<24;i++){app.menuState.trainingWeapon=i;app.menuState.trainingChar=0;app.startTraining();const g=app.game;if(g&&g.run&&g.run.player.currentWeapon.def.kind==='melee'){mi=i;break;}}const g=app.game,p=g.run.player,d=g.trainingDummy;p.currentWeapon.def.crit=0;return JSON.stringify({mods:p.mods.damageMul,base:p.currentWeapon.def.damage});})()"
Log ("SETUP " + (EvalJs $start))

# place player below dummy, aim up
Log ("PLACE " + (EvalJs "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.x=d.x;p.y=d.y+55;p.currentWeapon.def.crit=0;return 'dmg0='+d.damageTaken;})()"))
& playwright-cli "-s=$S" mousemove 640 240 2>&1 | Out-Null
Start-Sleep -Milliseconds 120

# TAP: press (starts charging), pin a sub-threshold charge, release -> 1x
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 60
Log ("TAP_PIN " + (EvalJs "(()=>{const p=window.__yuanqi.game.run.player;p.meleeCharge=0.05;return 'pin='+p.meleeCharge;})()"))
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 150
Log ("TAP " + (EvalJs "(()=>{const d=window.__yuanqi.game.trainingDummy;return 'dmg='+d.damageTaken;})()"))
Start-Sleep -Milliseconds 800

# CHARGED: press, pin full charge, release -> 2.5x
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 60
Log ("CHG_PIN " + (EvalJs "(()=>{const p=window.__yuanqi.game.run.player;p.meleeCharge=2.5;return 'pin='+p.meleeCharge;})()"))
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 150
Log ("CHARGED " + (EvalJs "(()=>{const d=window.__yuanqi.game.trainingDummy;return 'dmg='+d.damageTaken;})()"))

& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content 'mch_ratio.txt' -Encoding utf8
Write-Output 'RATIO-DONE'
