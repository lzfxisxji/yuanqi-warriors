# E2E verification: melee charge (2.5x) + deflect enemy projectiles  [requirement 30]
# ASCII only (no BOM). Drives the real input path via playwright mouse hold/release.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'
$S = 'mchS'

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

Log "=== enter training with a melee weapon (pick first melee in WEAPONS) ==="
$start = "(()=>{const app=window.__yuanqi;let mi=-1;for(let i=0;i<24;i++){app.menuState.trainingWeapon=i;app.menuState.trainingChar=0;app.startTraining();const g=app.game;if(g&&g.run&&g.run.player.currentWeapon.def.kind==='melee'){mi=i;break;}}const g=app.game;g.run.player.currentWeapon.def.crit=0;const p=g.run.player,d=g.trainingDummy;return JSON.stringify({meleeIdx:mi,kind:p.currentWeapon.def.kind,name:p.currentWeapon.def.name,base:p.currentWeapon.def.damage,dummy:!!d});})()"
Log ("START " + (EvalJs $start))

Log "=== place player just below dummy, aim up, do a TAP swing (expect 1x) ==="
$place = "(()=>{const g=window.__yuanqi.game,p=g.run.player,d=g.trainingDummy;p.x=d.x;p.y=d.y+55;p.currentWeapon.def.crit=0;return JSON.stringify({dmg0:d.damageTaken});})()"
Log ("PLACE " + (EvalJs $place))
& playwright-cli "-s=$S" mousemove 640 240 2>&1 | Out-Null
Start-Sleep -Milliseconds 130
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 90
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 150
Log ("TAP " + (EvalJs "(()=>{const d=window.__yuanqi.game.trainingDummy;return 'dmg='+d.damageTaken;})()"))
Start-Sleep -Milliseconds 800

Log "=== hold 2.6s (full charge) then release (expect 2.5x) ==="
& playwright-cli "-s=$S" mousemove 640 240 2>&1 | Out-Null
Start-Sleep -Milliseconds 130
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 1200
Log ("MIDCHARGE " + (EvalJs "(()=>{const p=window.__yuanqi.game.run.player;return 'ratio='+p.meleeChargeRatio.toFixed(3);})()"))
Start-Sleep -Milliseconds 1400
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 150
Log ("CHARGED " + (EvalJs "(()=>{const d=window.__yuanqi.game.trainingDummy;return 'dmg='+d.damageTaken;})()"))
& playwright-cli "-s=$S" screenshot --filename='.mch-inside.png' 2>&1 | Out-Null

Log "=== deflect enemy light-wave: spawn one in front, charged tap clears it ==="
$deflectPre = "(()=>{const g=window.__yuanqi.game,p=g.run.player;p.x=400;p.y=360;p.currentWeapon.def.crit=0;g.projectiles.spawn({kind:'orb',team:'enemy',x:p.x+70,y:p.y,angle:0,speed:0,damage:5,radius:9,life:5});const a=[];g.projectiles.collect(a);return 'before='+a.length;})()"
Log ("DEFLECT_PRE " + (EvalJs $deflectPre))
Start-Sleep -Milliseconds 130
& playwright-cli "-s=$S" mousemove 880 360 2>&1 | Out-Null
Start-Sleep -Milliseconds 130
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 450
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 150
Log ("DEFLECT_POST " + (EvalJs "(()=>{const g=window.__yuanqi.game;const a=[];g.projectiles.collect(a);return 'after='+a.length;})()"))

& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content 'mch_e2e.txt' -Encoding utf8
Write-Output 'MELEE-E2E-DONE'
