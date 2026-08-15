#!/usr/bin/env node
/* Does a bin seat in the lip of the bin below it, all the way up?
 *
 * This used to assert a 3x3 matrix of base styles against each other, because a short
 * foot could not enter a full lip and that was the one pairing which looks right on
 * screen and is not. There is one base now, so the matrix would be a matrix of one.
 * What survives is the part that was never about the styles: the lip's opening and the
 * foot that goes into it are two profiles maintained in different places — the lip is
 * an inset from the bin's outline, the foot comes from the published spec — and
 * nothing else checks that they agree at every height rather than at the step
 * heights.
 *
 * bin-audit samples the three corners of the lip table. This walks the whole lip in
 * 0.01 mm and descends the upper bin's real outer profile into it, body included,
 * because the body at full width is what would foul a lip the foot cleared.
 *
 * Both slopes are 45 degrees, so the answer is not merely "positive": the clearance is
 * the spec's 0.25 mm at every single height, and a change that tilts either profile
 * shows up here as a clearance that varies even while it stays positive.
 */
'use strict';
const { SPEC, LIP_TABLE, lipHeight, BIN_DEFAULTS } = require('../src/bins/bin.js');

const lipMin = BIN_DEFAULTS.lipMin !== undefined ? BIN_DEFAULTS.lipMin : 0.55;
const LIP_H = lipHeight(lipMin);
const CLEARANCE = 0.25;              // the spec's, per side

/* Inner half-width of the lip at height z above the top of the bin below. */
function lipInnerAt(z) {
  const steps = LIP_TABLE.concat([[LIP_H, lipMin]]);
  if (z > LIP_H) return Infinity;                // above the lip: nothing in the way
  for (let i = 0; i < steps.length - 1; i++) {
    const [z0, t0] = steps[i], [z1, t1] = steps[i + 1];
    if (z >= z0 && z <= z1) {
      const t = z1 > z0 ? t0 + (t1 - t0) * (z - z0) / (z1 - z0) : t0;
      return SPEC.half - t;
    }
  }
  return SPEC.half - steps[steps.length - 1][1];
}

/* Outer half-width of a bin at height z above its own base: the foot while the foot
   lasts, then the full body. */
function outerHalfAt(z) {
  const prof = SPEC.prof;
  if (z >= prof[prof.length - 1][0]) return SPEC.half;
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, h0] = prof[i], [z1, h1] = prof[i + 1];
    if (z >= z0 && z <= z1) return z1 > z0 ? h0 + (h1 - h0) * (z - z0) / (z1 - z0) : h0;
  }
  return prof[0][1];
}

let bad = 0;
console.log(`a bin descending into the lip below it (lip ${LIP_H.toFixed(2)} mm tall)`);
console.log('      z    lip inner   bin outer   clearance');

let worst = Infinity, worstAt = 0, widest = -Infinity;
for (let z = 0; z <= LIP_H + 1e-9; z += 0.01) {
  const clr = lipInnerAt(z) - outerHalfAt(z);
  if (clr < worst) { worst = clr; worstAt = z; }
  if (clr > widest) widest = clr;
}
for (const z of [0, 0.8, 2.6, LIP_H]) {
  const inner = lipInnerAt(z), outer = outerHalfAt(z);
  const clr = inner - outer;
  console.log(`   ${z.toFixed(2).padStart(4)}   ${inner.toFixed(2).padStart(9)}   ` +
              `${outer.toFixed(2).padStart(9)}   ${clr.toFixed(3).padStart(9)}` +
              `${Math.abs(clr - CLEARANCE) < 1e-6 ? '  ok' : '  OFF SPEC'}`);
}

const seats = worst > -1e-6;
console.log(`\n   tightest ${worst.toFixed(3)} mm at z ${worstAt.toFixed(2)} — ` +
            `${seats ? 'seats' : 'FOULS — it would perch on top'}`);
if (!seats) bad++;

const uniform = Math.abs(worst - CLEARANCE) < 1e-6 && Math.abs(widest - CLEARANCE) < 1e-6;
console.log(`   clearance across the whole lip: ${worst.toFixed(3)} to ${widest.toFixed(3)} mm — ` +
            `${uniform ? `uniform at the spec's ${CLEARANCE}` : 'NOT UNIFORM, the profiles disagree'}`);
if (!uniform) bad++;

console.log(bad ? `\n${bad} check(s) FAILED` : '\na bin seats in the bin below it');
process.exit(bad ? 1 : 0);
