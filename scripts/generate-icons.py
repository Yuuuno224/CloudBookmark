"""生成扩展图标（PNG）。

Chrome 的工具箱图标不支持 SVG，必须用位图，所以这里用 Pillow 画。

图案：圆角蓝色方块 + 白色书签丝带 + 一小片"云"的感觉（底部弧线）。
四个尺寸都单独渲染，保证 16px 下也看得清。
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")

BLUE_TOP = (59, 130, 246)     # #3b82f6
BLUE_BOTTOM = (37, 99, 235)   # #2563eb
WHITE = (255, 255, 255, 255)


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def render(size: int) -> Image.Image:
    # 4 倍超采样后缩小，边缘更干净
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(big * 0.22)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BLUE_BOTTOM)

    # 竖向渐变，让图标不那么扁平
    gradient = Image.new("RGBA", (1, big))
    for y in range(big):
        t = y / max(1, big - 1)
        gradient.putpixel((0, y), (lerp(BLUE_TOP[0], BLUE_BOTTOM[0], t),
                                   lerp(BLUE_TOP[1], BLUE_BOTTOM[1], t),
                                   lerp(BLUE_TOP[2], BLUE_BOTTOM[2], t), 255))
    gradient = gradient.resize((big, big))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    image = Image.composite(gradient, image, mask)

    # 中间的书签丝带
    draw = ImageDraw.Draw(image)
    ribbon_w = big * 0.34
    ribbon_h = big * 0.46
    left = (big - ribbon_w) / 2
    top = big * 0.24
    right = left + ribbon_w
    bottom = top + ribbon_h
    notch = ribbon_h * 0.26

    draw.polygon(
        [
            (left, top),
            (right, top),
            (right, bottom),
            ((left + right) / 2, bottom - notch),
            (left, bottom),
        ],
        fill=WHITE,
    )

    # 丝带上挖一条小横线，像"书签上的标记"
    if size >= 48:
        line_h = max(scale, int(big * 0.035))
        line_left = left + ribbon_w * 0.24
        line_right = right - ribbon_w * 0.24
        line_top = top + ribbon_h * 0.22
        draw.rounded_rectangle(
            [line_left, line_top, line_right, line_top + line_h],
            radius=line_h / 2,
            fill=(191, 219, 254, 255),
        )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
