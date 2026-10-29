"""Generate simple test STLs (stdlib only) for the TRAvel web slicer fixtures.

Shapes are unions of overlapping closed shells; PrusaSlicer unions overlapping
volumes when slicing, so no boolean operations are needed here.
"""
import math, struct, sys, os

def cyl(cx, cy, r, z0, z1, n=48, tilt=(0.0, 0.0)):
    """Closed cylinder (triangle list). tilt = (dx/dz, dy/dz) shear."""
    tris = []
    def ring(z):
        ox = cx + tilt[0] * (z - z0); oy = cy + tilt[1] * (z - z0)
        return [(ox + r * math.cos(2 * math.pi * i / n), oy + r * math.sin(2 * math.pi * i / n), z) for i in range(n)]
    b = ring(z0); t = ring(z1)
    cb = (cx, cy, z0); ct = (cx + tilt[0] * (z1 - z0), cy + tilt[1] * (z1 - z0), z1)
    for i in range(n):
        j = (i + 1) % n
        tris.append((b[i], t[i], t[j])); tris.append((b[i], t[j], b[j]))  # outward side
        tris.append((cb, b[j], b[i]))  # bottom cap (normal -z)
        tris.append((ct, t[i], t[j]))  # top cap (normal +z)
    return tris

def box(x0, y0, z0, x1, y1, z1):
    p = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
    return [(p[a],p[b],p[c]) for a,b,c in f]

def write_stl(path, tris):
    with open(path, 'wb') as fh:
        fh.write(b'\0' * 80); fh.write(struct.pack('<I', len(tris)))
        for a, b, c in tris:
            ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
            vx, vy, vz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
            nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
            l = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
            fh.write(struct.pack('<3f', nx/l, ny/l, nz/l))
            for p in (a, b, c): fh.write(struct.pack('<3f', *p))
            fh.write(b'\0\0')

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
# 1. plain cylinder vase: one loop per layer
write_stl(f'{out}/cylinder.stl', cyl(0, 0, 10, 0, 20))
# 2. Y: trunk splits into two branches leaning apart (branches overlap trunk at z=10)
y = cyl(0, 0, 10, 0, 11)
y += cyl(-4, 0, 5.5, 10, 40, tilt=(-0.45, 0))
y += cyl(4, 0, 5.5, 10, 40, tilt=(0.45, 0))
write_stl(f'{out}/y_split.stl', y)
# 3. two towers on one slab, 12 mm apart edge to edge (within a shroud radius, outside nozzle radius)
t = box(-22, -8, 0, 22, 8, 1)
t += cyl(-14, 0, 6, 1, 30); t += cyl(14, 0, 6, 1, 30)
write_stl(f'{out}/two_towers.stl', t)
# 4. two towers 80 mm apart (outside shroud radius): should print as two full spirals
f = cyl(-40, 0, 6, 0, 30) + cyl(40, 0, 6, 0, 30)
write_stl(f'{out}/far_towers.stl', f)
# 5. tube: annulus with a 3 mm wall (two loops per layer, ~2.6 mm apart centreline to centreline)
def tube(cx, cy, ro, ri, z0, z1, n=48):
    ring = lambda r, z: [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n), z) for i in range(n)]
    ob, ot, ib, it = ring(ro, z0), ring(ro, z1), ring(ri, z0), ring(ri, z1)
    tris = []
    for i in range(n):
        j = (i + 1) % n
        tris += [(ob[i], ot[i], ot[j]), (ob[i], ot[j], ob[j])]   # outer wall, normal out
        tris += [(ib[i], it[j], it[i]), (ib[i], ib[j], it[j])]   # inner wall, normal in
        tris += [(ob[i], ob[j], ib[j]), (ob[i], ib[j], ib[i])]   # bottom cap, normal -z
        tris += [(ot[i], it[j], ot[j]), (ot[i], it[i], it[j])]   # top cap, normal +z
    return tris
write_stl(f'{out}/tube.stl', tube(0, 0, 10, 8.5, 0, 15))      # walls ~1.1 mm apart: must alternate
write_stl(f'{out}/thick_tube.stl', tube(0, 0, 30, 20, 0, 15)) # walls ~9.5 mm apart: nozzle-height chunks
print('ok')
