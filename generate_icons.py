#!/usr/bin/env python3
# generate_icons.py - Creates simple PNG icons for the extension
import struct, zlib, os

def create_png(size, color=(124, 92, 252)):
    """Create a minimal valid PNG with a solid color and 'FA' text simulation"""
    r, g, b = color

    # Create RGBA image data
    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            # Rounded square background
            margin = size // 8
            in_rect = margin <= x < size - margin and margin <= y < size - margin
            # Gradient effect
            alpha = 255 if in_rect else 0
            # Slightly lighter in center for depth
            br = min(255, r + int(30 * (1 - abs(x - size/2) / size)))
            bg = min(255, g + int(20 * (1 - abs(y - size/2) / size)))
            bb = min(255, b + int(40 * (1 - abs(x - size/2) / size)))
            row.extend([br, bg, bb, alpha])
        pixels.append(bytes(row))

    def png_chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    signature = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)  # RGB not RGBA for simplicity

    # Use RGB
    rgb_pixels = []
    for y in range(size):
        row = [0]  # filter byte
        for x in range(size):
            margin = size // 8
            in_rect = margin <= x < size - margin and margin <= y < size - margin
            if in_rect:
                br = min(255, r + int(30 * (1 - abs(x - size/2) / size)))
                bg_val = min(255, g + int(20 * (1 - abs(y - size/2) / size)))
                bb = min(255, b + int(40 * (1 - abs(x - size/2) / size)))
                row.extend([br, bg_val, bb])
            else:
                row.extend([20, 20, 30])  # dark bg
        rgb_pixels.append(bytes(row))

    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    compressed = zlib.compress(b''.join(rgb_pixels))

    png = signature
    png += png_chunk(b'IHDR', ihdr_data)
    png += png_chunk(b'IDAT', compressed)
    png += png_chunk(b'IEND', b'')
    return png

os.makedirs('icons', exist_ok=True)
for size in [16, 48, 128]:
    with open(f'icons/icon{size}.png', 'wb') as f:
        f.write(create_png(size))
    print(f'Created icon{size}.png')
