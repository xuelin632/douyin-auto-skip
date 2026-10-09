"""给「抖音标记视频自动跳过」生成图标（16/32/48/128）。

风格与同系列的带货插件保持一致：深色圆角方块 + 圆环图形，
只是把「禁止播放」的红圈换成青色的「跳到下一条」双三角。
先画在 512x512 上再降采样，小尺寸边缘才干净。
"""

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

S = 512
BG = (24, 26, 31, 255)          # 深色底 #181A1F
RING = (43, 217, 196, 255)      # 青色环 #2BD9C4
FG = (255, 255, 255, 255)       # 白色双三角

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方块底
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)

# 圆环
pad = int(S * 0.14)
d.ellipse([pad, pad, S - pad, S - pad], outline=RING, width=int(S * 0.075))

# 环内「跳到下一条」：两个三角 + 一根竖条（⏭）
cx, cy = S / 2, S / 2
h = S * 0.30          # 三角高度
w = S * 0.155         # 三角底宽
gap = S * 0.02
x0 = cx - w * 1.35

for i in range(2):
    left = x0 + i * (w + gap)
    d.polygon(
        [(left, cy - h / 2), (left + w, cy), (left, cy + h / 2)],
        fill=FG,
    )

bar_x = x0 + 2 * (w + gap) + S * 0.01
d.rounded_rectangle(
    [bar_x, cy - h / 2, bar_x + S * 0.038, cy + h / 2],
    radius=int(S * 0.012),
    fill=FG,
)

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, "icon%d.png" % size))
    print("wrote", os.path.join(OUT, "icon%d.png" % size))
