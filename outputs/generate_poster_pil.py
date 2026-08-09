import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import qrcode

BASE = r"E:\个人学习\agent\agent-skill-platform\outputs"
qr_path = os.path.join(BASE, "skilldepot_qr.png")
out_path = os.path.join(BASE, "skilldepot_team_poster.png")

# 朋友圈竖版最佳比例 4:5
W, H = 1080, 1350

# 字体
font_bold = r"C:\Windows\Fonts\msyhbd.ttc"
font_regular = r"C:\Windows\Fonts\msyh.ttc"

def get_font(path, size):
    return ImageFont.truetype(path, size)

# 创建画布
img = Image.new("RGB", (W, H), "#020617")
draw = ImageDraw.Draw(img)

# 1. 背景网格
grid_color = (99, 102, 241, 20)
grid_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
grid_draw = ImageDraw.Draw(grid_img)
step = 54
for x in range(0, W, step):
    grid_draw.line([(x, 0), (x, H)], fill=grid_color, width=1)
for y in range(0, H, step):
    grid_draw.line([(0, y), (W, y)], fill=grid_color, width=1)

# 网格中心向四周淡出的遮罩
mask = Image.new("L", (W, H), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.ellipse([W*0.5 - 700, H*0.25 - 700, W*0.5 + 700, H*0.25 + 700], fill=120)
mask = mask.filter(ImageFilter.GaussianBlur(radius=120))
grid_img.putalpha(mask)
img = Image.alpha_composite(img.convert("RGBA"), grid_img)

# 2. 光晕
def add_glow(img, center, radius, color, opacity=0.45, blur=120):
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    x, y = center
    gdraw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color + (int(255 * opacity),))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=blur))
    return Image.alpha_composite(img, glow)

# 左上紫光
img = add_glow(img, (-80, -80), 400, (79, 70, 229), opacity=0.55, blur=130)
# 右下青蓝光
img = add_glow(img, (W + 100, H - 400), 450, (6, 182, 212), opacity=0.5, blur=130)
# 底部紫光
img = add_glow(img, (W // 2, H + 100), 500, (139, 92, 246), opacity=0.28, blur=140)

# 装饰圆环（右侧）
ring = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ring_draw = ImageDraw.Draw(ring)
ring_draw.ellipse([W - 220, 260, W + 60, 540], outline=(99, 102, 241, 45), width=2)
ring_draw.ellipse([W - 186, 294, W + 26, 506], outline=(6, 182, 212, 35), width=2)
img = Image.alpha_composite(img, ring)

# 转回 RGB 用于后续文字绘制
img = img.convert("RGB")
draw = ImageDraw.Draw(img)

# 3. 品牌区
logo_x, logo_y = 60, 72
logo_size = 64
# logo 渐变方块（上下渐变）
logo_grad = Image.new("RGBA", (logo_size, logo_size))
for y in range(logo_size):
    r = int(99 + (99 - 99) * y / logo_size)
    g = int(102 + (182 - 102) * y / logo_size)
    b = int(241 + (212 - 241) * y / logo_size)
    ImageDraw.Draw(logo_grad).line([(0, y), (logo_size, y)], fill=(r, g, b, 255))
# 圆角蒙版
logo_mask = Image.new("L", (logo_size, logo_size), 0)
ImageDraw.Draw(logo_mask).rounded_rectangle([0, 0, logo_size, logo_size], radius=16, fill=255)
logo_round = Image.new("RGBA", (logo_size, logo_size), (0,0,0,0))
logo_round.paste(logo_grad, (0,0), logo_mask)
# S 文字
s_font = get_font(font_bold, 34)
lg_draw = ImageDraw.Draw(logo_round)
bbox = lg_draw.textbbox((0,0), "S", font=s_font)
tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
lg_draw.text(((logo_size-tw)//2, (logo_size-th)//2 - 2), "S", font=s_font, fill="white")
img.paste(logo_round, (logo_x, logo_y), logo_round)

# 品牌名
brand_font = get_font(font_bold, 38)
draw.text((logo_x + logo_size + 16, logo_y + 2), "SkillDepot", font=brand_font, fill="#ffffff")
# tag
tag_font = get_font(font_regular, 18)
draw.text((logo_x + logo_size + 16, logo_y + 48), "AI AGENT SKILLS MARKETPLACE", font=tag_font, fill="#94a3b8")

# 4. Hero 区
hero_y = 190
eyebrow_font = get_font(font_bold, 20)
eyebrow_text = "团队功能正式上线"
bbox = draw.textbbox((0,0), eyebrow_text, font=eyebrow_font)
ew, eh = bbox[2]-bbox[0], bbox[3]-bbox[1]
pad_x, pad_y = 20, 8
badge_w, badge_h = ew + pad_x*2 + 18, eh + pad_y*2  # +18 给圆点
badge_x, badge_y = 60, hero_y
# 徽章背景
draw.rounded_rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h], radius=999, fill=(99,102,241,30), outline=(99,102,241,90), width=1)
# 圆点
draw.ellipse([badge_x + 14, badge_y + (badge_h-8)//2, badge_x + 22, badge_y + (badge_h-8)//2 + 8], fill="#22d3ee")
draw.text((badge_x + 32, badge_y + pad_y - 1), eyebrow_text, font=eyebrow_font, fill="#a5b4fc")

# 主标题
title_font = get_font(font_bold, 78)
line1 = "一个人做 AI"
line2 = "不如一群人做团队"
draw.text((60, hero_y + 70), line1, font=title_font, fill="#ffffff")
# 渐变文字：简单用蓝色到紫色模拟
bbox = draw.textbbox((0,0), "不如一群人做", font=title_font)
line2_x = 60
line2_y = hero_y + 70 + 84
draw.text((line2_x, line2_y), "不如一群人做", font=title_font, fill="#ffffff")
# "团队" 用渐变效果（用颜色近似）
team_bbox = draw.textbbox((0,0), "团队", font=title_font)
draw.text((line2_x + (bbox[2]-bbox[0]), line2_y), "团队", font=title_font, fill="#22d3ee")

# 副标题
sub_font = get_font(font_regular, 28)
draw.text((60, hero_y + 250), "在 SkillDepot 创建你的 AI 团队，让 Agent 技能以组织", font=sub_font, fill="#cbd5e1")
draw.text((60, hero_y + 292), "身份上榜、变现、沉淀。", font=sub_font, fill="#cbd5e1")

# 5. 卖点卡片
features = [
    ("团", "团队主页", "一站式展示团队全部技能与核心成员，打造专业开发者形象。"),
    ("榜", "团队榜单", "实时周榜/总榜，公平算法让优质团队上榜。"),
    ("订", "会员订阅", "团队技能打包变现，订阅用户有效期内免费下载全部技能。"),
    ("协", "协作沉淀", "成员共建共享，解散团队技能自动回归个人，资产不丢失。"),
]
card_y = hero_y + 370
card_w = (W - 60*2 - 20) // 2
card_h = 178
icon_size = 52
for idx, (icon, title, desc) in enumerate(features):
    col = idx % 2
    row = idx // 2
    x = 60 + col * (card_w + 20)
    y = card_y + row * (card_h + 20)
    # 卡片背景（RGB 模式不用 alpha，直接用深色底）
    draw.rounded_rectangle([x, y, x + card_w, y + card_h], radius=22, fill="#0f172a", outline="#1e293b", width=1)
    # icon 背景
    draw.rounded_rectangle([x + 24, y + 24, x + 24 + icon_size, y + 24 + icon_size], radius=14, fill=(99,102,241,38), outline=(99,102,241,64), width=1)
    icon_font = get_font(font_regular, 28)
    bbox = draw.textbbox((0,0), icon, font=icon_font)
    iw, ih = bbox[2]-bbox[0], bbox[3]-bbox[1]
    draw.text((x + 24 + (icon_size-iw)//2, y + 24 + (icon_size-ih)//2 - 2), icon, font=icon_font, fill="#ffffff")
    # title
    title_f = get_font(font_bold, 26)
    draw.text((x + 24, y + 88), title, font=title_f, fill="#ffffff")
    # desc（自动换行，最多 2 行）
    desc_f = get_font(font_regular, 20)
    def wrap_text(text, font, max_w):
        lines = []
        line = ""
        for ch in text:
            test = line + ch
            if draw.textbbox((0,0), test, font=font)[2] > max_w and line:
                lines.append(line)
                line = ch
                if len(lines) >= 2:
                    line = line.rstrip() + "…"
                    break
            else:
                line = test
        if line and len(lines) < 2:
            lines.append(line)
        return lines[:2]
    desc_lines = wrap_text(desc, desc_f, card_w - 48)
    for li, line in enumerate(desc_lines):
        draw.text((x + 24, y + 122 + li * 34), line, font=desc_f, fill="#94a3b8")

# 6. 底部 CTA + 二维码
footer_y = H - 300
# 分割线
draw.line([(60, footer_y), (W-60, footer_y)], fill=(255,255,255,12), width=1)

cta_font = get_font(font_bold, 38)
draw.text((60, footer_y + 36), "扫码创建", font=cta_font, fill="#ffffff")
draw.text((60, footer_y + 84), "你的 AI 团队", font=cta_font, fill="#22d3ee")

sub2_font = get_font(font_regular, 22)
draw.text((60, footer_y + 152), "专为跨境电商卖家与 AI 开发者打造的技能市场", font=sub2_font, fill="#94a3b8")

domain_font = get_font(font_regular, 20)
draw.text((60, footer_y + 190), "skills.rehomi.com", font=domain_font, fill="#64748b")

# 二维码（动态生成，指向团队榜落地页，避免外部 PNG 与 URL 不同步）
qr_size = 220
QR_TARGET = "https://skills.rehomi.com/leaderboard?type=team"
_qr = qrcode.QRCode(version=4, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=2)
_qr.add_data(QR_TARGET)
_qr.make(fit=True)
qr = _qr.make_image(fill_color="black", back_color="white").convert("RGB")
qr = qr.resize((qr_size, qr_size), Image.Resampling.LANCZOS)
qr_bg = Image.new("RGB", (qr_size + 28, qr_size + 28), "#ffffff")
qr_bg.paste(qr, (14, 14))
# 圆角
qr_mask = Image.new("L", (qr_size + 28, qr_size + 28), 0)
ImageDraw.Draw(qr_mask).rounded_rectangle([0,0,qr_size+28,qr_size+28], radius=24, fill=255)
qr_round = Image.new("RGBA", (qr_size + 28, qr_size + 28), (0,0,0,0))
qr_round.paste(qr_bg, (0,0), qr_mask)
img.paste(qr_round, (W - 60 - qr_size - 28, footer_y + 24), qr_round)

# 保存
img.save(out_path, "PNG", quality=95)
print(f"Generated: {out_path} size={img.size}")
