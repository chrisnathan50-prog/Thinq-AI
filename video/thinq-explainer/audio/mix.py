"""Music bed + UI sound design + voiceover mix for the Thinq explainer.

Everything sits on the same timeline as scene.html. 100 BPM (beat = 0.6 s);
the chord changes on each shot cut, so the harmony moves with the story.
Run:  python3 mix.py   ->  mix.wav (48 kHz stereo, pre-loudnorm)
"""
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly

SR = 48000
DUR = 41.4 + 1.8          # tail so the last chord rings out under the fade
N = int(SR * DUR)
rng = np.random.default_rng(7)   # seeded: the mix is reproducible
BEAT = 0.6
SHOTS = [0, 3.6, 6.6, 10.2, 14.4, 19.2, 24.0, 27.6, 31.2, 34.8, 41.4]
NCH = len(SHOTS) - 1; END = NCH - 1   # last chapter = end card

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
    [F-5, F+7, F+12, F+14, F+19],        # Csus       approve: waiting for OK
    [F-8, F-1, F+2, F+7, F+11],          # Am7        voice + docs
    [F-3, F+4, F+12, F+15, F+19],        # Dm9        memory (breakdown)
    [F-7, F+2, F+9, F+12, F+16],         # Bbmaj9     routines
    [F-5, F+7, F+12, F+14, F+19],        # Csus       group bots: lift into the end
    [F-12, F+7, F+12, F+16, F+19, F+26], # Fmaj9 low  end card: home
]

# pad: detuned sines through a soft lowpass, crossfading at each cut
for k, ch in enumerate(CHORDS):
    a = SHOTS[k] - (0.25 if k else 0); b = (SHOTS[k + 1] + 0.5) if k < END else DUR
    n = int((b - a) * SR); tt = t_axis(n); sig = np.zeros(n)
    for m in ch:
        for det in (-0.07, 0.0, 0.07):
            f = mtof(m) * 2 ** (det / 12)
            sig += np.sin(2 * np.pi * f * tt + rng.uniform(0, 6.28)) * (0.6 if det == 0 else 0.3)
            sig += 0.12 * np.sin(2 * np.pi * 2 * f * tt)
    sig = lp(sig, 1800 if k < END else 2400) / len(ch)
    sig *= env_adsr(n, 0.45 if k else 0.08, 0.6 if k < END else 2.0) * (1 + 0.04 * np.sin(2 * np.pi * 0.3 * tt))
    place(music, sig, a, 0.20 if k else 0.15)

# sub bass on the root, enters with the window (shot 2)
for k in range(1, NCH):
    a = SHOTS[k]; b = SHOTS[k + 1] if k < END else DUR - 0.4
    n = int((b - a) * SR); tt = t_axis(n)
    root = CHORDS[k][0] - 12 + (12 if CHORDS[k][0] < 41 else 0)
    sig = np.sin(2 * np.pi * mtof(root) * tt) * env_adsr(n, 0.05, 0.3)
    place(music, sig, a, 0.16 if k < END else 0.2)

# pluck arpeggio: 8ths from shot 2 to the end card, voiced high, panned gently
def pluck(f, n_s=0.45, bright=1.0):
    n = int(n_s * SR); tt = t_axis(n)
    s = np.sin(2 * np.pi * f * tt) + 0.35 * bright * np.sin(2 * np.pi * 2 * f * tt) + 0.1 * np.sin(2 * np.pi * 3 * f * tt)
    return s * np.exp(-tt * 9) * np.minimum(1, tt * 400)
PATTERN = [0, 2, 1, 3, 2, 4, 1, 3]
step = BEAT / 2
t = SHOTS[1]
i = 0
while t < SHOTS[END] - 0.01:
    k = max(j for j in range(NCH) if SHOTS[j] <= t + 1e-6)
    ch = CHORDS[k]; m = ch[1:][PATTERN[i % 8] % (len(ch) - 1)] + 12
    acc = 1.0 if i % 2 == 0 else 0.62
    place(music, pluck(mtof(m)), t, 0.075 * acc, pan=0.35 * np.sin(i * 0.9))
    t += step; i += 1

# groove (features-video style): syncopated kick, snare on 2 and 4, 16th shaker,
# electric-piano chord stabs. Builds in from shot 2, full from shot 3, drops at the end card.
def kick():
    n = int(0.32 * SR); tt = t_axis(n)
    f = 46 + 70 * np.exp(-tt * 28); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 11)
def snare():
    n = int(0.22 * SR); tt = t_axis(n)
    body = np.sin(2 * np.pi * 190 * tt) * np.exp(-tt * 30)
    nz = bp(rng.standard_normal(n), 1800, 9000) * np.exp(-tt * 18)
    return body * 0.5 + nz * 0.8
def shaker():
    n = int(0.07 * SR); return hp(rng.standard_normal(n), 6500) * np.exp(-t_axis(n) * 60)
def epiano(notes, n_s=0.55):
    n = int(n_s * SR); tt = t_axis(n); s = np.zeros(n)
    for m in notes:
        f = mtof(m)
        s += (np.sin(2 * np.pi * f * tt + 0.8 * np.sin(2 * np.pi * f * tt) * np.exp(-tt * 9))   # FM bark
              + 0.18 * np.sin(2 * np.pi * 7 * f * tt) * np.exp(-tt * 30))
    s *= np.exp(-tt * 4.5) * np.minimum(1, tt * 300) * (1 + 0.15 * np.sin(2 * np.pi * 5 * tt))
    return lp(s, 4200) / len(notes)
SIXT = BEAT / 4
KICK = [0, 6, 10]          # in 16ths within a bar of 16: syncopated
STAB = [2, 7, 11, 14]
bar0 = SHOTS[1]
k16 = 0
while bar0 + k16 * SIXT < SHOTS[END] - 0.01:
    t16 = bar0 + k16 * SIXT; pos = k16 % 16
    shot = max(j for j in range(NCH) if SHOTS[j] <= t16 + 1e-6)
    full = shot >= 2 and shot != 6            # memory chapter is a breakdown
    if shot == 6 and t16 >= SHOTS[7] - 0.6: place(music, snare(), t16, 0.05 + 0.08 * (t16 - SHOTS[7] + 0.6) / 0.6)  # fill back in
    if full and pos in KICK: place(music, kick(), t16, 0.34)
    if full and pos in (4, 12): place(music, snare(), t16, 0.12, pan=0.05)
    if shot >= 1 and pos % 2 == 1: place(music, shaker(), t16, 0.035 if pos % 4 == 3 else 0.02, pan=0.35)
    if pos in STAB:
        ch = CHORDS[shot]; v = sorted(m + 12 if m < 57 else m for m in ch[1:4])
        place(music, epiano(v), t16, 0.12 if full else 0.08, pan=-0.2)
    k16 += 1

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

# A: three app tiles slam in (bell + thump), cards fan out with soft ticks
for at, m, pan in [(0.06, 77, -0.35), (0.84, 81, 0.35), (1.64, 84, -0.35)]:
    place(sfx, bell(mtof(m)), at + 0.12, 0.12, pan); place(sfx, thump(), at + 0.14, 0.26, pan)
for at in (0.32, 0.55, 1.06, 1.30, 1.86, 2.10): place(sfx, tick(2600, 0.04), at + 0.1, 0.07, 0.15); place(sfx, whoosh(0.18), at, 0.05)
for j in range(14): place(sfx, tick(3200 + 60 * j), 0.4 + j * 0.19, 0.03, 0.4)
# B: nine items land as dots of the mark, the mark completes and becomes the icon
place(sfx, whoosh(0.9), 3.45, 0.16)
for j, m in enumerate([72, 74, 77, 79, 81, 84, 86, 89, 91]): place(sfx, bell(mtof(m), 0.6), 4.12 + j * 0.1, 0.05, -0.4 + 0.1 * j)
for j in range(4): place(sfx, tick(4200, 0.03), 4.82 + j * 0.06, 0.05)
place(sfx, bell(mtof(65), 2.2), 5.0, 0.12); place(sfx, bell(mtof(77), 1.8), 5.02, 0.07)
place(sfx, thump(), 5.62, 0.3)
# C: app opens, typing, send, reply rows
place(sfx, whoosh(0.6), 6.45, 0.18)
for j in range(11): place(sfx, tick(1800 + (j % 3) * 260, 0.025), 7.25 + j * (0.7 / 11), 0.07, -0.1)
place(sfx, tick(1300, 0.05), 7.98, 0.16); place(sfx, whoosh(0.3), 8.05, 0.07)
for j in range(3): place(sfx, bell(mtof(84 + [0, 3, 7][j]), 0.6), 9.0 + j * 0.28, 0.05, -0.2 + 0.2 * j)
# D: second message, dive through the screen, calendar builds, scan, slot found
for j in range(14): place(sfx, tick(1800 + (j % 3) * 260, 0.025), 10.25 + j * (0.57 / 14), 0.06, -0.1)
place(sfx, tick(1300, 0.05), 10.85, 0.16)
place(sfx, whoosh(0.8), 10.95, 0.22)
for j in range(10): place(sfx, tick(2200 + 90 * j, 0.03), 11.38 + j * 0.06, 0.035, -0.4 + 0.08 * j)
place(sfx, whoosh(0.85), 12.3, 0.08)
place(sfx, bell(mtof(84), 1.4), 13.2, 0.12); place(sfx, bell(mtof(91), 1.2), 13.26, 0.07, 0.3); place(sfx, thump(), 13.2, 0.2)
# E: slot lifts into the invite, email slides up, two taps, both confirm, sweep out
place(sfx, whoosh(0.8), 14.45, 0.16); place(sfx, whoosh(0.6), 14.85, 0.1)
place(sfx, tick(1100, 0.06), 18.22, 0.22); place(sfx, bell(mtof(84), 1.2), 18.32, 0.1)
place(sfx, tick(1100, 0.06), 18.7, 0.22); place(sfx, bell(mtof(88), 1.2), 18.8, 0.09, 0.3)
place(sfx, whoosh(1.1), 18.85, 0.24)
# F: voice capsule pops (liquid), transcript, contract drops, lens finds three dates
place(sfx, thump(), 19.38, 0.2); place(sfx, bell(mtof(79), 0.8), 19.4, 0.06)
place(sfx, whoosh(0.5), 20.55, 0.12); place(sfx, thump(), 21.2, 0.16)
place(sfx, whoosh(0.4), 21.9, 0.07)
for j, m in enumerate([84, 88, 91]): place(sfx, bell(mtof(m), 0.9), 22.32 + j * 0.42, 0.08, -0.3 + 0.3 * j)
place(sfx, bell(mtof(96), 1.0), 23.28, 0.06)
# G: the drop falls, splashes, the memory card blooms, two rows check, signature typed
place(sfx, whoosh(0.5), 23.95, 0.1)
def splash():
    n = int(0.35 * SR); tt = t_axis(n)
    return (np.sin(2 * np.pi * (300 + 900 * np.exp(-tt * 18)) * tt) * 0.6 + bp(rng.standard_normal(n), 800, 5000) * 0.5) * np.exp(-tt * 12)
place(sfx, splash(), 24.42, 0.22)
place(sfx, bell(mtof(77), 1.6), 24.5, 0.1)
for j in range(2): place(sfx, bell(mtof(84 + 4 * j), 0.8), 24.85 + j * 0.38, 0.07)
for j in range(4): place(sfx, tick(1900 + 200 * j, 0.025), 25.92 + j * 0.11, 0.07)
# H: flip, toggle, five briefs
place(sfx, whoosh(0.5), 27.5, 0.14)
place(sfx, tick(900, 0.06), 28.85, 0.22); place(sfx, tick(2600, 0.04), 29.0, 0.08)
for j, m in enumerate([79, 81, 84, 86, 88]): place(sfx, bell(mtof(m), 0.7), 29.16 + j * 0.3, 0.07, -0.4 + 0.2 * j)
# I: pan, three messages
place(sfx, whoosh(0.9), 30.95, 0.16)
for at, m in [(31.78, 81), (32.68, 84), (33.38, 88)]: place(sfx, bell(mtof(m), 0.8), at, 0.08); place(sfx, thump(), at, 0.1)
# J: collapse, dots converge, glass icon blooms, orbit shimmer, CTA
place(sfx, whoosh(1.2), 34.4, 0.2)
for j in range(13): place(sfx, tick(3000 + 120 * j, 0.03), 35.1 + j * 0.045, 0.04, -0.5 + 0.08 * j)
place(sfx, bell(mtof(53), 3.4), 35.35, 0.18); place(sfx, bell(mtof(65), 2.8), 35.4, 0.13); place(sfx, bell(mtof(77), 2.2), 35.45, 0.07)
for j, m in enumerate([84, 88, 91, 96]): place(sfx, bell(mtof(m), 1.0), 35.65 + j * 0.12, 0.035, -0.45 + 0.3 * j)
place(sfx, bell(mtof(84), 1.8), 37.9, 0.06, 0.2)

# ---------- voiceover ----------
VO = [("p0a", 0.15), ("p0b", 1.00), ("p0c", 1.85), ("vo1_af_heart", 3.75), ("vo2_af_heart", 6.75),
      ("n1a", 10.35), ("n1b", 12.45), ("n2", 14.55), ("n3a", 19.35), ("n3b", 20.55), ("n3c", 22.15),
      ("n4", 24.2), ("p4a", 27.75), ("p4b", 28.75), ("n5", 31.35), ("vo5_af_heart", 35.0), ("n6", 37.85)]
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
fade = np.ones(N); fi = int(41.6 * SR); fade[fi:] = np.linspace(1, 0, N - fi) ** 2

mix = (music * 0.72 + sfx * 1.0 + vo2 * 1.0) * fade[:, None]
mix = np.tanh(mix * 1.1) / 1.1   # soft clip safety
sf.write("mix.wav", mix.astype(np.float32), SR)
print("peak", round(float(np.abs(mix).max()), 3), "len", round(N / SR, 2))
