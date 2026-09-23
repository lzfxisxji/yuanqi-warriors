# E2E verification: prism laser must NOT shake the screen (requirement 32)
# ASCII only (no BOM). Drives both the real input path and a deterministic 219 FPS loop.
#
# Why two phases:
#   The removed bug was `ctx.shake.add(0.008)` executed EVERY FRAME inside updateBeam.
#   ScreenShake decays by real time (dt * 1.7 per frame) but was fed by a per-frame constant,
#   so shaking only appeared above 1.7 / 0.008 = 212.5 FPS. Headless Chromium runs ~60 FPS,
#   where the bug is invisible -- a plain "hold the button" test can never catch it.
#   PHASE B therefore drives the REAL main loop (`game.update(dt)`) synchronously for 1752
#   frames at dt = 1/219, which is exactly the user's reported frame rate, and samples the
#   live `game.shake` object every frame.
#
#   PHASE C is the control: it proves the sampling harness CAN see shake, so PHASE B passing
#   is not a vacuous "shake never moves" result.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..
$out = New-Object System.Collections.Generic.List[string]
$U = 'http://127.0.0.1:8799/'
$S = 'beamS'

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
(()=>{const app=window.__yuanqi;let bi=-1;for(let i=0;i<24;i++){app.menuState.trainingWeapon=i;app.menuState.trainingChar=0;app.startTraining();const g=app.game;if(g&&g.run&&g.run.player.currentWeapon.def.kind==='beam'){bi=i;break;}}const g=app.game;const p=g.run.player;return JSON.stringify({beamIdx:bi,kind:p.currentWeapon.def.kind,name:p.currentWeapon.def.name,mag:p.currentWeapon.magSize,mode:g.mode,ended:g.ended,net:g.netRole});})()
'@
Log ("START " + (EvalJs $start))

# ---------------------------------------------------------------------------
Log "=== PHASE A: real input path -- hold mouse 2.5s, beam must fire, no shake ==="
& playwright-cli "-s=$S" mousemove 640 360 2>&1 | Out-Null
Start-Sleep -Milliseconds 300
$pre = "(()=>{const g=window.__yuanqi.game,s=g.shake;return JSON.stringify({ammo:Math.round(g.run.player.currentWeapon.ammo),mag:g.shake.scale,magAbs:Math.abs(s.offsetX)+Math.abs(s.offsetY)+Math.abs(s.rotation)});})()"
Log ("A_PRE " + (EvalJs $pre))
& playwright-cli "-s=$S" mousedown 2>&1 | Out-Null
Start-Sleep -Milliseconds 2500
Log ("A_HOLDING " + (EvalJs "(()=>{const g=window.__yuanqi.game,s=g.shake;return 'beam='+g.run.player.beamActive+' ammo='+Math.round(g.run.player.currentWeapon.ammo)+' shakeAbs='+(Math.abs(s.offsetX)+Math.abs(s.offsetY)+Math.abs(s.rotation));})()"))
& playwright-cli "-s=$S" mouseup 2>&1 | Out-Null
Start-Sleep -Milliseconds 250
Log ("A_RELEASED " + (EvalJs "(()=>{const g=window.__yuanqi.game;return 'beam='+g.run.player.beamActive;})()"))

# ---------------------------------------------------------------------------
Log "=== PHASE B: deterministic 219 FPS x 1752 frames (8s) on the real update loop ==="
$loop = @'
(()=>{const app=window.__yuanqi,g=app.game,p=g.run.player,inp=g.host.input;
p.currentWeapon.ammo=999999;
const d=g.trainingDummy;
if(d){p.x=d.x;p.y=d.y+150;}
inp.pointer.down=true;
const dt=1/219,N=1752;
let maxTrauma=0,maxAbs=0,maxX=0,maxY=0,maxRot=0,beamFrames=0,paused=0;
const ammo0=p.currentWeapon.ammo;
const dmg0=d?d.damageTaken:0;
for(let i=0;i<N;i++){
  g.update(dt);
  if(g.mode!=='play')paused++;
  const s=g.shake;
  const t=typeof s.trauma==='number'?s.trauma:-1;
  if(t>maxTrauma)maxTrauma=t;
  const ax=Math.abs(s.offsetX),ay=Math.abs(s.offsetY),ar=Math.abs(s.rotation);
  if(ax>maxX)maxX=ax; if(ay>maxY)maxY=ay; if(ar>maxRot)maxRot=ar;
  if(ax+ay+ar>maxAbs)maxAbs=ax+ay+ar;
  if(p.beamActive)beamFrames++;
}
inp.pointer.down=false;
return JSON.stringify({frames:N,dtFps:219,mode:g.mode,notPlayFrames:paused,beamFrames:beamFrames,
  maxTrauma:maxTrauma,maxShakeAbs:maxAbs,maxOffX:maxX,maxOffY:maxY,maxRot:maxRot,
  ammoUsed:Math.round(ammo0-p.currentWeapon.ammo),dummyDmg:Math.round((d?d.damageTaken:0)-dmg0),
  beam:g.run.player.beamActive});})()
'@
Log ("B_LOOP " + (EvalJs $loop))

# ---------------------------------------------------------------------------
Log "=== PHASE C: control -- same sampler, one real shake source (dash skill) must be SEEN ==="
$ctrl = @'
(()=>{const app=window.__yuanqi,g=app.game,s=g.shake;
s.add(0.12);let maxAbs=0,maxTrauma=0;
for(let i=0;i<30;i++){g.update(1/219);const a=Math.abs(s.offsetX)+Math.abs(s.offsetY)+Math.abs(s.rotation);if(a>maxAbs)maxAbs=a;const t=typeof s.trauma==='number'?s.trauma:-1;if(t>maxTrauma)maxTrauma=t;}
return JSON.stringify({controlMaxShakeAbs:maxAbs,controlMaxTrauma:maxTrauma});
})()
'@
Log ("C_CONTROL " + (EvalJs $ctrl))

& playwright-cli "-s=$S" screenshot --filename='.beam-noshake.png' 2>&1 | Out-Null
& playwright-cli "-s=$S" close 2>&1 | Out-Null
$out -join "`n" | Set-Content 'beam_e2e.txt' -Encoding utf8
Write-Output 'BEAM-NOSHAKE-E2E-DONE'
