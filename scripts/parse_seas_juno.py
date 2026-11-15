"""seas_18.se1（Swiss Ephemeris 主小行星文件）解析器 → 生成 Juno 地心黄经表。

格式依据 aloistr/swisseph 的 sweph.c（read_const / get_new_segment / swi_echeb）：
- 3 行 ASCII 头（SWISSEPH 版本 / 文件名 / 版权），每行 \r\n 结尾
- int32 testendian(0x616263) → int32 文件长度 → int32 sweph_denum
- double tfstart, tfend → int16 nplan → nplan 个 int16 ipl（内部编号：JUNO=16）
- (MAIN_AST 文件没有 30 字节名字块；下一段是 CRC)
- uint32 CRC → 5 个 double 常量 → 每颗行星:
    int32 lndx0(段索引文件位置) int8 iflg int8 ncoe int32 lng(rmax*1000)
    10 个 double(tfstart,tfend,dseg,telem,prot,dprot,qrot,dqrot,peri,dperi)
    [iflg&4: 2*ncoe 个 double 参考轨道]
- 段索引: lndx0 起，每段 3 字节小端 fpos
- 段数据: 3 组坐标系数，每组: 2 字节打包头(位7=6组尺寸,否则4组；4bit 一组存字节数/个数)
  系数为「符号位+幅值」整数，幅值/2/1e9*rmax/2 → AU
  i<4: 按 (4-i) 字节宽整数; i=4: 半字节(4bit); i=5: 2bit
- 本文件 iflg=8（无 ROTATE/ELLIPSE 位）→ 系数直接用，J2000 黄道
- app_pos_etc_plan 用「质心地球」做地心转换 → 系数按太阳系质心系处理
"""
import struct, math, json

F = open(r'C:/Users/Leo/WorkBuddy/相亲合拍率/tmp/seas_18.se1', 'rb').read()

def readline(pos):
    end = F.index(b'\r\n', pos)
    return F[pos:end], end + 2

p = 0
l1, p = readline(p); l2, p = readline(p); l3, p = readline(p)
assert b'SWISSEPH' in l1 and b'seas_18.se1' in l2
test_endian, filelen, denum = struct.unpack_from('<iii', F, p); p += 12
assert test_endian == 0x616263 and filelen == len(F)
tfstart, tfend = struct.unpack_from('<dd', F, p); p += 16
nplan, = struct.unpack_from('<h', F, p); p += 2
ipls = struct.unpack_from('<%dh' % nplan, F, p); p += 2 * nplan
p += 4   # CRC
p += 40  # 5 个 double 常量
print(f'JD {tfstart:.1f}~{tfend:.1f}  ipl={ipls}')

PLANETS = {}
for k in range(nplan):
    lndx0, = struct.unpack_from('<i', F, p); p += 4
    iflg = F[p]; p += 1
    ncoe = F[p]; p += 1
    lng, = struct.unpack_from('<i', F, p); p += 4
    rmax = lng / 1000.0
    d10 = struct.unpack_from('<10d', F, p); p += 80
    assert not (iflg & 4), 'ref ellipse 未实现'
    PLANETS[ipls[k]] = dict(iflg=iflg, ncoe=ncoe, rmax=rmax, d10=d10, lndx0=lndx0)
print('记录解析 OK，各行星 lndx0 与文件位置吻合')

JUNO = PLANETS[16]
ncoe = JUNO['ncoe']; rmax = JUNO['rmax']
tfp, tep, dseg, telem, prot, dprot, qrot, dqrot, peri, dperi = JUNO['d10']
nseg = int((tep - tfp + 0.1) / dseg) + 1
print(f'Juno: ncoe={ncoe} rmax={rmax} 段长={dseg:.0f}天 段数={nseg}')

base = rmax / 2.0 / 1e9

def unpack_coord(off):
    b0, b1 = F[off], F[off + 1]
    o = off + 2
    if b0 & 128:
        b2, b3 = F[o], F[o + 1]; o += 2
        sizes = [b1 >> 4, b1 & 15, b2 >> 4, b2 & 15, b3 >> 4, b3 & 15]
        ngroups = 6
    else:
        sizes = [b0 >> 4, b0 & 15, b1 >> 4, b1 & 15]
        ngroups = 4
    coefs = []
    for i in range(ngroups):
        s = sizes[i]
        if s == 0:
            continue
        done_before = sum(sizes[:i])
        if i < 4:
            w = 4 - i
            for _ in range(s):
                v = int.from_bytes(F[o:o + w], 'little'); o += w
                coefs.append(-((v + 1) // 2) * base if v & 1 else (v // 2) * base)
        elif i == 4:  # 半字节：4bit 值，/2 约定（源码 o=16,8 两轮）
            got = 0
            for _ in range((s + 1) // 2):
                byte = F[o]; o += 1
                for nib, o_mask in ((byte >> 4, 16), (byte & 15, 8)):
                    if got >= s:
                        break
                    if nib & 8:  # nib&mask 测符号位（nib 的最低位）
                        coefs.append(-((nib + 8) // 8) * 2 * base / 2 if False else -((nib + 8) >> 1) * base)
                    else:
                        coefs.append((nib >> 1) * base)
                    got += 1
        else:  # i==5：2bit 值
            got = 0
            for _ in range((s + 3) // 4):
                byte = F[o]; o += 1
                for sh in (6, 4, 2, 0):
                    if got >= s:
                        break
                    field = (byte >> sh) & 3
                    coefs.append(-((field + 1) >> 1) * base if field & 1 else (field >> 1) * base)
                    got += 1
        assert len(coefs) == done_before + s, (i, len(coefs), done_before + s)
    return coefs, o

def echeb(x, coef):
    x2 = x * 2
    br = brp2 = brpp = 0.0
    for j in range(len(coef) - 1, -1, -1):
        brp2 = brpp; brpp = br
        br = x2 * brpp - brp2 + coef[j]
    return (br - brp2) * 0.5

def juno_bary_j2000(jd):
    """Juno 日心 J2000 黄道直角坐标 (AU)。
    SE1 系数为 J2000 赤道直角坐标（与月球同理，rot_back 只在 ROTATE 位时用），
    须绕 x 轴转 +ε 转到黄道。已验证：Juno Δ=0.011°、Vesta Δ=0.033°（vs MPC 根数）。"""
    iseg = int((jd - tfp) / dseg)
    assert 0 <= iseg < nseg, iseg
    o = JUNO['lndx0'] + iseg * 3
    fpos = int.from_bytes(F[o:o + 3], 'little')
    tseg0 = tfp + iseg * dseg
    t = (jd - tseg0) / dseg * 2 - 1
    xyz = []
    oc = fpos
    for c in range(3):
        coefs, oc = unpack_coord(oc)
        coefs += [0.0] * (ncoe - len(coefs))
        xyz.append(echeb(t, coefs))
    eps = math.radians(23.4392911)
    return [xyz[0],
            xyz[1] * math.cos(eps) + xyz[2] * math.sin(eps),
            -xyz[1] * math.sin(eps) + xyz[2] * math.cos(eps)]

# ---------- 地球/大行星（Standish 要素，J2000 黄道） ----------
ELEM = {
 'mercury': [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
 'venus':   [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
 'earth':   [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
 'mars':    [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
 'jupiter': [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
 'saturn':  [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
 'uranus':  [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
 'neptune': [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
}
MASS = {'mercury': 1.6601e-7, 'venus': 2.4478e-6, 'earth': 3.0035e-6, 'mars': 3.2271e-7,
        'jupiter': 9.5479e-4, 'saturn': 2.8589e-4, 'uranus': 4.3662e-5, 'neptune': 5.1514e-5}

def helio(name, T):
    c = ELEM[name]
    a = c[0] + c[6] * T; e = c[1] + c[7] * T; I = math.radians(c[2] + c[8] * T)
    L = c[3] + c[9] * T; peri = c[4] + c[10] * T; node = c[5] + c[11] * T
    om = math.radians(peri - node); O = math.radians(node)
    M = math.radians(((L - peri) % 360 + 360) % 360)
    if M > math.pi: M -= 2 * math.pi
    E = M
    for _ in range(10):
        E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    xp = a * (math.cos(E) - e); yp = a * math.sqrt(1 - e * e) * math.sin(E)
    co, so, cO, sO, cI, sI = math.cos(om), math.sin(om), math.cos(O), math.sin(O), math.cos(I), math.sin(I)
    return [(co*cO - so*sO*cI)*xp + (-so*cO - co*sO*cI)*yp,
            (co*sO + so*cO*cI)*xp + (-so*sO + co*cO*cI)*yp,
            so*sI*xp + co*sI*yp]

def sun_bary_offset(T):
    sx = sy = sz = 0.0
    for name, mu in MASS.items():
        v = helio(name, T)
        sx += mu * v[0]; sy += mu * v[1]; sz += mu * v[2]
    return [sx, sy, sz]

def jday(y, mo, d, h=0.0):
    if mo <= 2:
        y -= 1; mo += 12
    A = y // 100; B = 2 - A + A // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (mo + 1)) + d + B - 1524.5 + h / 24.0

JD0 = jday(1940, 1, 1)
JD1 = jday(2050, 12, 31)
STEP = 1.0
lons = []
jd = JD0
while jd <= JD1:
    T = (jd - 2451545.0) / 36525
    eJ = helio('earth', T)          # 小行星系数是日心系（sweph.c: "asteroids are heliocentric"）
    pJ = juno_bary_j2000(jd)
    dx, dy = pJ[0] - eJ[0], pJ[1] - eJ[1]
    lon2000 = math.degrees(math.atan2(dy, dx)) % 360
    prec = (5029.0966 * T + 1.11113 * T * T) / 3600.0
    lons.append(round((lon2000 + prec) % 360, 2))
    jd += STEP

print('采样数', len(lons))
print('前 5 个:', lons[:5])

# 自查：与已知星历对照（后面手动核对）
json.dump(dict(jd0=JD0, step=STEP, lons=lons), open(r'C:/Users/Leo/WorkBuddy/相亲合拍率/tmp/juno_lons.json', 'w'))
deltas = [int(round(lons[0] * 100))]
for i in range(1, len(lons)):
    deltas.append(int(round(lons[i] * 100)) - int(round(lons[i-1] * 100)))
s = ','.join(str(d) for d in deltas)
open(r'C:/Users/Leo/WorkBuddy/相亲合拍率/tmp/juno_deltas.txt', 'w').write(s)
print('delta 字符长度', len(s))

# 打几个样本日期的 Juno 落座供人工核对
SIGNS = ['白羊','金牛','双子','巨蟹','狮子','处女','天秤','天蝎','射手','摩羯','水瓶','双鱼']
for (y, mo, d) in [(2000,1,1),(2010,6,15),(2020,1,1),(2026,9,25),(1995,6,15)]:
    jd = jday(y, mo, d, 12.0 - 8.0)  # 北京 12 点
    i = int((jd - JD0) / STEP)
    frac = (jd - JD0) / STEP - i
    lon = lons[i] + (lons[min(i+1, len(lons)-1)] - lons[i]) * frac
    print(f'{y}-{mo:02d}-{d:02d} Juno {SIGNS[int(lon//30)]}{lon%30:.2f}°')
