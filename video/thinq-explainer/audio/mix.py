"""Music bed + UI sound design + voiceover mix for the Thinq explainer.

Everything sits on the same timeline as scene.html. 100 BPM (beat = 0.6 s);
the chord changes on each shot cut, so the harmony moves with the story.
Run:  python3 mix.py   ->  mix.wav (48 kHz stereo, pre-loudnorm)
"""
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly

SR = 48000
DUR = 20.4 + 1.6          # tail so the last chord rings out under the fade
N = int(SR * DUR)
rng = np.random.default_rng(7)   # seeded: the mix is reproducible
BEAT = 0.6
SHOTS = [0, 3.6, 6.6, 10.2, 14.4, 17.4, 20.4]

def mtof(m): return 440 * 2 ** ((m - 69) / 12)
def t_axis(n): return np.arange(n) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def place(buf, sig, at, gain=1.0, pan=0.0):
    i = int(at * SR); j = min(N, i + len(sig))
    if j <= i: return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:j, 0] += sig[:j - i] * gain * l * 1.414
    buf[i:j, 1] += sig[:j - i] * gain * r * 1.414
def env_adsr(n, a, r):
    e = np.ones(n); ai = max(1, int(a * SR)); ri = max(1, int(r * SR))
    e[:ai] = np.linspace(0, 1, ai) ** 2; e[-ri:] *= np.linspace(1, 0, ri) ** 1.5
    return e

music = np.zeros((N, 2)); sfx = np.zeros((N, 2))

# ---------- harmony: one chord per shot (F major, warm and unhurried) ----------
F = 53  # F3
CHORDS = [
    [F, F+7, F+16, F+19, F+26],          # Fmaj9      shot 1: the pile-up
    [F-3, F+4, F+12, F+15, F+19],        # Dm9        shot 2: gathering
    [F-7, F+2, F+9, F+12, F+16],         # Bbmaj9     shot 3: plan
    [F-10, F+4, F+7, F+14, F+17],        # Gm11-ish   shot 4: waiting for OK
    [F-5, F+7, F+12, F+14, F+19],        # Csus       shot 5: tension, keeps going
    [F-12, F+7, F+12, F+16, F+19, F+26], # Fmaj9 low  end card: home
]

# pad: detuned sines through a soft lowpass, crossfading at each cut
for k, ch in enumerate(CHORDS):
    a = SHOTS[k] - (0.25 if k else 0); b = (SHOTS[k + 1] + 0.5) if k < 5 else DUR
    n = int((b - a) * SR); tt = t_axis(n); sig = np.zeros(n)
    for m in ch:
        for det in (-0.07, 0.0, 0.07):
            f = mtof(m) * 2 ** (det / 12)
            sig += np.sin(2 * np.pi * f * tt + rng.uniform(0, 6.28)) * (0.6 if det == 0 else 0.3)
            sig += 0.12 * np.sin(2 * np.pi * 2 * f * tt)
    sig = lp(sig, 1800 if k < 5 else 2400) / len(ch)
    sig *= env_adsr(n, 0.45 if k else 0.08, 0.6 if k < 5 else 1.4) * (1 + 0.04 * np.sin(2 * np.pi * 0.3 * tt))
    place(music, sig, a, 0.20 if k else 0.15)

# sub bass on the root, enters with the window (shot 2)
for k in range(1, 6):
    a = SHOTS[k]; b = SHOTS[k + 1] if k < 5 else DUR - 0.4
    n = int((b - a) * SR); tt = t_axis(n)
    root = CHORDS[k][0] - 12 + (12 if CHORDS[k][0] < 41 else 0)
    sig = np.sin(2 * np.pi * mtof(root) * tt) * env_adsr(n, 0.05, 0.3)
    place(music, sig, a, 0.16 if k < 5 else 0.2)

# pluck arpeggio: 8ths from shot 2 to the end card, voiced high, panned gently
def pluck(f, n_s=0.45, bright=1.0):
    n = int(n_s * SR); tt = t_axis(n)
    s = np.sin(2 * np.pi * f * tt) + 0.35 * bright * np.sin(2 * np.pi * 2 * f * tt) + 0.1 * np.sin(2 * np.pi * 3 * f * tt)
    return s * np.exp(-tt * 9) * np.minimum(1, tt * 400)
PATTERN = [0, 2, 1, 3, 2, 4, 1, 3]
step = BEAT / 2
t = SHOTS[1]
i = 0
while t < SHOTS[5] - 0.01:
    k = max(j for j in range(6) if SHOTS[j] <= t + 1e-6)
    ch = CHORDS[k]; m = ch[1:][PATTERN[i % 8] % (len(ch) - 1)] + 12
    acc = 1.0 if i % 2 == 0 else 0.62
    place(music, pluck(mtof(m)), t, 0.075 * acc, pan=0.35 * np.sin(i * 0.9))
    t += step; i += 1

# soft kick on beats (shots 3-5) and a shaker on off-beats (shots 4-5)
def kick():
    n = int(0.32 * SR); tt = t_axis(n)
    f = 46 + 70 * np.exp(-tt * 28); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 11)
def shaker():
    n = int(0.09 * SR); return hp(rng.standard_normal(n), 6000) * np.exp(-t_axis(n) * 55)
b = SHOTS[2]
while b < SHOTS[5] - 0.01:
    place(music, kick(), b, 0.30)
    if b >= SHOTS[3]: place(music, shaker(), b + BEAT / 2, 0.05, pan=0.3)
    b += BEAT

# ---------- UI sound design (in sfx bus, not ducked) ----------
def bell(f, n_s=1.2):
    n = int(n_s * SR); tt = t_axis(n)
    s = np.sin(2 * np.pi * f * tt) + 0.4 * np.sin(2 * np.pi * f * 2.76 * tt) * np.exp(-tt * 6) + 0.2 * np.sin(2 * np.pi * f * 5.4 * tt) * np.exp(-tt * 12)
    return s * np.exp(-tt * 3.2) * np.minimum(1, tt * 600)
def tick(f=2400, n_s=0.03):
    n = int(n_s * SR); tt = t_axis(n)
    return (np.sin(2 * np.pi * f * tt) * 0.6 + bp(rng.standard_normal(n), 2000, 7000) * 0.4) * np.exp(-tt * 180)
def whoosh(n_s, up=True):
    n = int(n_s * SR); tt = t_axis(n); x = rng.standard_normal(n)
    out = np.zeros(n); seg = 1200
    for s0 in range(0, n, seg):   # stepped band sweep
        p = s0 / n; c = (300 + 3500 * (p if up else 1 - p))
        out[s0:s0 + seg] = bp(x[max(0, s0 - 600):s0 + seg], c * 0.6, min(c * 1.6, 20000))[-len(out[s0:s0 + seg]):]
    e = np.sin(np.pi * tt / (n / SR)) ** 2
    return out * e
def thump():
    n = int(0.18 * SR); tt = t_axis(n)
    return np.sin(2 * np.pi * (90 + 120 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 22)

# shot 1: each card lands with a bell rising through the chord + a thump
for at, m, pan in [(0.10, 77, -0.3), (0.86, 81, 0.25), (1.64, 84, -0.1)]:
    place(sfx, bell(mtof(m)), at + 0.08, 0.12, pan); place(sfx, thump(), at + 0.1, 0.22, pan)
# counters climbing: quiet ticks
for j in range(14): place(sfx, tick(3200 + 60 * j), 0.4 + j * 0.19, 0.035, 0.4)
# shot 2: cards rush into the window, Telegram pops in, spark turns
place(sfx, whoosh(0.85), 3.3, 0.16)
place(sfx, bell(mtof(88), 0.9), 4.62, 0.08, 0.45)
place(sfx, bell(mtof(81), 1.6), 4.95, 0.07)
# shot 3: typing, send, typing dots, reply rows
for j in range(11): place(sfx, tick(1800 + (j % 3) * 260, 0.025), 6.82 + j * (0.68 / 11), 0.07, -0.15)
place(sfx, tick(1400, 0.05), 7.6, 0.14); place(sfx, whoosh(0.3), 7.68, 0.06)
for j in range(3): place(sfx, bell(mtof(84 + [0, 3, 7][j]), 0.6), 8.62 + j * 0.3, 0.05, -0.2 + 0.2 * j)
# shot 4: sheet slides up, cursor presses Send, confirmation
place(sfx, whoosh(0.7), 10.05, 0.16)
place(sfx, tick(1200, 0.06), 13.04, 0.2)
place(sfx, bell(mtof(84), 1.4), 13.16, 0.09); place(sfx, bell(mtof(88), 1.4), 13.26, 0.07, 0.3)
# shot 5: routine card, toggle, the week checks itself off on a rising scale
place(sfx, whoosh(0.5, up=False), 14.1, 0.12)
place(sfx, tick(900, 0.06), 15.2, 0.2); place(sfx, tick(2600, 0.04), 15.3, 0.08)
for j, m in enumerate([77, 79, 81, 84, 86]): place(sfx, bell(mtof(m), 0.7), 15.66 + j * 0.3, 0.06, -0.4 + 0.2 * j)
# end card: swell into the spark, low bell under the wordmark
place(sfx, whoosh(1.0), 16.75, 0.16)
place(sfx, bell(mtof(65), 2.4), 17.55, 0.14); place(sfx, bell(mtof(77), 2.0), 17.6, 0.08)
place(sfx, bell(mtof(84), 1.6), 18.82, 0.05, 0.2)

# ---------- voiceover ----------
VO = [("p0a", 0.15), ("p0b", 1.00), ("p0c", 1.85),
      ("vo1_af_heart", 3.75), ("vo2_af_heart", 6.75), ("vo3_af_heart", 10.35),
      ("p4a", 14.50), ("p4b", 15.45), ("vo5_af_heart", 17.55)]
vo = np.zeros(N)
for name, at in VO:
    x, sr = sf.read(f"{name}.wav")
    x = resample_poly(x, SR, sr)
    x = hp(x, 90) ; x = x / np.max(np.abs(x)) * 0.9
    i = int(at * SR); vo[i:i + len(x)] += x[:N - i]
# gentle presence lift + light compression feel
vo = vo + 0.25 * bp(vo, 2500, 6000)
vo2 = np.stack([vo, vo], 1)

# sidechain: duck music ~10 dB while she speaks (80 ms attack, 250 ms release)
act = np.convolve(np.abs(vo) > 0.02, np.ones(int(0.05 * SR)), 'same') > 0
g = np.where(act, 10 ** (-10 / 20), 1.0)
sm = np.empty_like(g); s = 1.0
a_up, a_dn = np.exp(-1 / (0.25 * SR)), np.exp(-1 / (0.08 * SR))
for idx in range(N):
    c = a_dn if g[idx] < s else a_up
    s = c * s + (1 - c) * g[idx]; sm[idx] = s
music *= sm[:, None]

# final fade on the tail
fade = np.ones(N); fi = int(20.0 * SR); fade[fi:] = np.linspace(1, 0, N - fi) ** 2

mix = (music * 0.72 + sfx * 1.0 + vo2 * 1.0) * fade[:, None]
mix = np.tanh(mix * 1.1) / 1.1   # soft clip safety
sf.write("mix.wav", mix.astype(np.float32), SR)
print("peak", round(float(np.abs(mix).max()), 3), "len", round(N / SR, 2))
