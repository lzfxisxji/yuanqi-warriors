# E2E verification: training-camp damage must be VISIBLE (requirement 33)
# ASCII only (no BOM). Drives the real main loop at the user's reported 219 FPS and
# samples live damage numbers + the training banner readout.
#
# Root cause of the report: the beam WAS dealing damage (PROBE proved ~89/s) but
# DamageContext.numbers was a dead field, so no floating number ever appeared, and
# the dummy's health bar is pinned full (infiniteHp). This script proves the fix end
# to end in a real browser: numbers spawn, and the top banner shows live damage/DPS.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'
$S = 'dmgN'

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

Log "=== enter training with the beam (laser) weapon ==="
$start = @'
(()=>{const app=window.__yuanqi;let bi=-1;for(let i=0;i<24;i++){app.menuState.trainingWeapon=i;app.menuState.trainingChar=0;app.startTraining();const g=app.game;if(g&&g.run&&g.run.player.currentWeapon.def.kind==='beam'){bi=i;break;}}const g=app.game;const p=g.run.player;return JSON.stringify({beamIdx:bi,kind:p.currentWeapon.def.kind,name:p.currentWeapon.def.name,mode:g.mode,ended:g.ended,net:g.netRole});})()
'@
Log ("START " + (EvalJs $start))

# ---------------------------------------------------------------------------
Log "=== PHASE B: deterministic 219 FPS x 1752 frames (8s) on the real update loop, beam aimed at dummy ==="
$loop = @'
(()=>{const app=window.__yuanqi,g=app.game,p=g.run.player,inp=g.host.input;
p.currentWeapon.ammo=999999;
const d=g.trainingDummy;
if(d){p.x=d.x;p.y=d.y+150;}
inp.pointer.down=true;
const dt=1/219,N=1752;
let maxN=0,beamFrames=0,paused=0;
const dmg0=d?d.damageTaken:0;
const cam=g.host.renderer.camera;
for(let i=0;i<N;i++){
  if(d){inp.pointer.sx=640+(d.x-cam.x);inp.pointer.sy=360+(d.y-cam.y);}
  g.update(dt);
  if(g.mode!=='play')paused++;
  const nl=g.numbers.list.length; if(nl>maxN)maxN=nl;
  if(p.beamActive)beamFrames++;
}
inp.pointer.down=false;
const b=(typeof g.objectiveBanner==='function')?g.objectiveBanner():null;
return JSON.stringify({frames:N,dtFps:219,mode:g.mode,notPlayFrames:paused,beamFrames:beamFrames,
  maxNumbers:maxN,dummyDmg:Math.round((d?d.damageTaken:0)-dmg0),
  trainingDamage:Math.round(g.trainingDamage),trainingTime:+g.trainingTime.toFixed(2),
  banner:b?b.text:null,beam:g.run.player.beamActive});})()
'@
Log ("B_LOOP " + (EvalJs $loop))

# ---------------------------------------------------------------------------
Log "=== PHASE C: control -- numbers must be absent when beam hits nothing ==="
$ctrl = @'
(()=>{const app=window.__yuanqi,g=app.game,p=g.run.player,inp=g.host.input;
inp.pointer.down=false; // no firing
g.numbers.list.length=0;
g.update(1/60);
return JSON.stringify({controlNumbers:g.numbers.list.length});})()
'@
Log ("C_CONTROL " + (EvalJs $ctrl))

& playwright-cli "-s=$S" screenshot --filename='.damage-numbers.png' 2>&1 | Out-Null
& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content 'damage_e2e.txt' -Encoding utf8
Write-Output 'DAMAGE-NUMBERS-E2E-DONE'
