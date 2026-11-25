/** Unit tests for the image engine: operations, codecs and helpers. */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decode, encode, stripJpegMetadata, defaultFormat, normalizeFormat } from '../src/core/codec.js';
import { Img, OpError, newImg, parseColor, hasAlpha, crop as rawCrop } from '../src/core/img.js';
import { blur, blurWithInfo } from '../src/core/ops/blur.js';
import { detectFaces } from '../src/core/ops/faces.js';
import { FILTERS, applyFilter, adjust, autoEnhance } from '../src/core/ops/filters.js';
import {
    SOCIAL_PRESETS, addBorder, collage, cropAspect, cropBox, cropCircle, resize, rotateFlip, roundCorners, socialResize, trimBorders, upscale,
} from '../src/core/ops/geometry.js';
import { addText, addWatermark, palette, removeSolidBackground } from '../src/core/ops/overlay.js';
import { runPipeline } from '../src/core/ops/pipeline.js';
import { RING_STYLES, profileRing } from '../src/core/ops/ring.js';
import { makeUploadToken, verifyUploadToken } from '../src/auth.js';

const fixture = (n: string) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const px = (img: Img, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const solid = (w = 600, h = 400, c: [number, number, number, number] = [120, 160, 200, 255]) => newImg(w, h, c);
function checker(w = 600, h = 400): Img {
    const img = newImg(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 ? 255 : 0;
        img.data.set([v, v, v, 255], (y * w + x) * 4);
    }
    return img;
}
/** Mean absolute difference of the gray value along a row segment. */
function changed(a: Img, b: Img, row: number, x0: number, x1: number): number {
    let s = 0;
    for (let x = x0; x < x1; x++) s += Math.abs(px(a, x, row)[0] - px(b, x, row)[0]);
    return s / (x1 - x0);
}

describe('geometry', () => {
    it('crops to an aspect ratio, with zoom and focus', () => {
        expect(cropAspect(solid(), { aspect_ratio: '1:1' }).width).toBe(400);
        const c = cropAspect(solid(1200, 800), { aspect_ratio: '16:9', focus_x: 1, zoom: 2 });
        expect(c.width).toBe(600);
        expect(Math.abs(c.width / c.height - 16 / 9)).toBeLessThan(0.01);
    });
    it('rejects a crop box outside the image', () => {
        expect(() => cropBox(solid(), { x: 550, y: 0, width: 100, height: 10 })).toThrow(/outside the image/);
    });
    it('makes a circle with transparent corners', async () => {
        const c = await cropCircle(solid(), { size: 300 });
        expect([c.width, c.height]).toEqual([300, 300]);
        expect(px(c, 0, 0)[3]).toBe(0);
        expect(px(c, 150, 150)[3]).toBe(255);
    });
    it('resizes in every fit mode', async () => {
        expect((await resize(solid(1200, 800), { width: 600 })).height).toBe(400);
        expect((await resize(solid(1200, 800), { width: 500, height: 500, fit: 'cover' })).width).toBe(500);
        const contain = await resize(solid(1200, 800), { width: 500, height: 500, fit: 'contain' });
        expect([contain.width, contain.height]).toEqual([500, 333]);
        expect((await resize(solid(1200, 800), { width: 500, height: 500, fit: 'pad' })).height).toBe(500);
        await expect(resize(solid())).rejects.toThrow(OpError);
    });
    it('upscales within limits', async () => {
        expect((await upscale(solid(300, 200), { factor: 2 })).width).toBe(600);
        await expect(upscale(solid(), { factor: 5 })).rejects.toThrow(/at most 4/);
    });
    it('rotates losslessly by 90 and mirrors', async () => {
        const r = await rotateFlip(solid(1200, 800), { angle: 90 });
        expect([r.width, r.height]).toEqual([800, 1200]);
        expect((await rotateFlip(solid(), { flip: 'horizontal' })).width).toBe(600);
    });
    it('hits every social preset size in every fit', async () => {
        for (const preset of ['instagram_story', 'youtube_thumbnail', 'linkedin_banner']) {
            const [w, h] = SOCIAL_PRESETS[preset];
            for (const fit of ['cover', 'pad', 'blur_pad']) {
                const o = await socialResize(solid(), { preset, fit });
                expect([o.width, o.height]).toEqual([w, h]);
            }
        }
    });
    it('adds borders, rounds corners, trims', async () => {
        expect((await addBorder(solid(100, 100), { width: 10 })).width).toBe(120);
        expect(px(roundCorners(solid(200, 200), { radius: 40 }), 0, 0)[3]).toBe(0);
        const t = solid(200, 200, [255, 255, 255, 255]);
        for (let y = 60; y < 140; y++) for (let x = 50; x < 150; x++) t.data.set([255, 0, 0, 255], (y * 200 + x) * 4);
        const trimmed = trimBorders(t);
        expect([trimmed.width, trimmed.height]).toEqual([100, 80]);
    });
    it('builds a collage grid', async () => {
        const c = await collage([solid(), solid(), solid()], { cell_size: 100, gap: 10 });
        expect([c.width, c.height]).toEqual([230, 230]);
    });
});

describe('profile ring', () => {
    for (const style of Object.keys(RING_STYLES)) {
        it(`renders style ${style}`, async () => {
            const r = await profileRing(solid(), { style, size: 300 });
            expect([r.width, r.height]).toEqual([300, 300]);
            expect(px(r, 0, 0)[3]).toBe(0);
            expect(px(r, 150, 150)[3]).toBe(255);
        });
    }
    it('paints the ring in the requested color', async () => {
        const r = await profileRing(solid(), { style: 'linkedin_blue', size: 400, ring_width: 0.1 });
        const [red, , blue, a] = px(r, 200, 5);
        expect(a).toBeGreaterThan(200);
        expect(blue).toBeGreaterThan(red);
    });
    it('draws the curved label (letters, not just the band)', async () => {
        const withLabel = await profileRing(solid(), { style: 'open_to_work', size: 400, arc_center: 90 });
        const noLabel = await profileRing(solid(), { style: 'open_to_work', size: 400, arc_center: 90, label: '' });
        let diff = 0;
        for (let x = 120; x < 280; x++) for (let y = 370; y < 395; y++) diff += Math.abs(px(withLabel, x, y)[0] - px(noLabel, x, y)[0]);
        expect(diff).toBeGreaterThan(5000); // white letters on the green band
    });
});

describe('filters and adjustments', () => {
    for (const name of Object.keys(FILTERS)) {
        it(`filter ${name} keeps size and alpha`, async () => {
            const img = solid(120, 80, [200, 100, 50, 128]);
            const out = await applyFilter(img, { filter: name, intensity: 0.8 });
            expect([out.width, out.height]).toEqual([120, 80]);
            expect(px(out, 5, 5)[3]).toBe(128);
        });
    }
    it('rejects an unknown filter', async () => {
        await expect(applyFilter(solid(), { filter: 'glitter' })).rejects.toThrow(/Unknown filter/);
    });
    it('emboss produces mid-gray relief on flat areas', async () => {
        const out = await applyFilter(solid(50, 50), { filter: 'emboss' });
        expect(px(out, 25, 25)[0]).toBeGreaterThan(120);
        expect(px(out, 25, 25)[0]).toBeLessThan(136);
    });
    it('adjust validates ranges and brightens', async () => {
        const out = await adjust(solid(), { brightness: 1.5 });
        expect(px(out, 10, 10)[0]).toBeGreaterThan(150);
        await expect(adjust(solid(), { gamma: 9 })).rejects.toThrow(/gamma/);
    });
    it('auto enhance runs', async () => {
        expect((await autoEnhance(checker(100, 100))).width).toBe(100);
    });
});

describe('smart blur', () => {
    it('blurs inside, fades over the feather, leaves the rest untouched', async () => {
        const cb = checker();
        const out = await blur(cb, { x: 200, y: 100, width: 200, height: 200, feather: 60, radius: 10 });
        expect(changed(cb, out, 200, 290, 310)).toBeGreaterThan(60);
        const band = changed(cb, out, 200, 165, 175);
        expect(band).toBeGreaterThan(10);
        expect(band).toBeLessThan(changed(cb, out, 200, 290, 310));
        expect(changed(cb, out, 200, 100, 130)).toBe(0);
    });
    it('hard edge when feather is 0', async () => {
        const cb = checker();
        expect(changed(cb, await blur(cb, { x: 200, y: 100, width: 200, height: 200, feather: 0, radius: 10 }), 200, 185, 198)).toBe(0);
    });
    it('handles several regions and ellipses', async () => {
        const cb = checker();
        const out = await blur(cb, { regions: [{ x: 10, y: 10, width: 100, height: 100 }, { x: 400, y: 200, width: 150, height: 100 }], shape: 'ellipse', feather: 0 });
        expect(changed(cb, out, 60, 50, 70)).toBeGreaterThan(30);
        expect(changed(cb, out, 12, 10, 14)).toBe(0); // ellipse leaves the box corner sharp
    });
    it('invert keeps the region sharp', async () => {
        const cb = checker();
        const out = await blur(cb, { x: 200, y: 100, width: 200, height: 200, invert: true, feather: 0, radius: 10 });
        expect(changed(cb, out, 200, 250, 350)).toBe(0);
        expect(changed(cb, out, 200, 20, 120)).toBeGreaterThan(30);
    });
    it('reports bad regions clearly', async () => {
        await expect(blur(checker(), { regions: [{ x: 5000, y: 0, width: 10, height: 10 }] })).rejects.toThrow(/outside the image/);
        await expect(blur(checker(), { invert: true })).rejects.toThrow(/needs a region/);
    });
});

describe('face detection', () => {
    it('finds the face in a real photo', async () => {
        const { img } = await decode(fixture('astronaut.jpg'));
        const faces = await detectFaces(img);
        expect(faces.length).toBe(1);
        const f = faces[0];
        expect(f.x).toBeGreaterThan(90);
        expect(f.x).toBeLessThan(140);
        expect(f.width).toBeGreaterThan(40);
    }, 30_000);
    it('finds several faces of different sizes', async () => {
        const { img } = await decode(fixture('astronaut.jpg'));
        const g = newImg(1000, 420, [255, 255, 255, 255]);
        const { compositeOver } = await import('../src/core/img.js');
        for (const [sz, x] of [[400, 0], [300, 420], [220, 740]] as const) compositeOver(g, await resize(img, { width: sz, height: sz }), x, 420 - sz);
        expect((await detectFaces(g)).length).toBe(3);
    }, 30_000);
    it('finds nothing on a plain image', async () => {
        expect(await detectFaces(solid())).toEqual([]);
    });
    it('blurs detected faces / the background', async () => {
        const { img } = await decode(fixture('astronaut.jpg'));
        const { info } = await blurWithInfo(img, { detect: 'faces' });
        expect(info.regions_blurred).toBe(1);
        expect(info.shape).toBe('ellipse');
        const bg = await blurWithInfo(img, { detect: 'faces', invert: true });
        expect(bg.info.regions_kept_sharp).toBe(1);
        await expect(blurWithInfo(solid(300, 300), { detect: 'faces' })).rejects.toThrow(/No faces/);
    }, 30_000);
});

describe('overlays, background, palette, pipeline', () => {
    it('draws text and watermarks', async () => {
        const t = await addText(solid(), { text: 'Hello world OPEN TO WORK', box_color: '#00000080' });
        expect(t.width).toBe(600);
        expect((await addWatermark(solid(), { text: '© me', tiled: true })).width).toBe(600);
        expect((await addWatermark(solid(), { position: 'top_right' }, solid(80, 40, [255, 0, 0, 255]))).width).toBe(600);
    });
    it('removes a solid background but keeps white inside the subject', async () => {
        const im = solid(100, 100, [255, 255, 255, 255]);
        for (let y = 20; y <= 80; y++) for (let x = 20; x <= 80; x++) im.data.set([0, 0, 255, 255], (y * 100 + x) * 4);
        for (let y = 45; y <= 55; y++) for (let x = 45; x <= 55; x++) im.data.set([255, 255, 255, 255], (y * 100 + x) * 4);
        const edges = await removeSolidBackground(im, { feather: 0 });
        expect(px(edges, 2, 2)[3]).toBe(0);
        expect(px(edges, 50, 50)[3]).toBe(255);
        expect(px(await removeSolidBackground(im, { mode: 'everywhere', feather: 0 }), 50, 50)[3]).toBe(0);
    });
    it('palette keeps a small accent color exact', async () => {
        const im = newImg(200, 100, [0x0b, 0x20, 0x3b, 255]);
        for (let y = 0; y < 100; y++) {
            for (let x = 90; x < 180; x++) im.data.set([3, 130, 135, 255], (y * 200 + x) * 4);
            for (let x = 180; x < 200; x++) im.data.set([248, 150, 40, 255], (y * 200 + x) * 4);
        }
        const hexes = (await palette(im, 3)).map(([h]) => h);
        expect(hexes).toEqual(expect.arrayContaining(['#F89628', '#0B203B', '#038287']));
    });
    it('runs a pipeline and validates params', async () => {
        const out = await runPipeline(solid(1200, 800), [{ op: 'crop_aspect', aspect_ratio: '1:1' }, { op: 'apply_filter', filter: 'warm' }, { op: 'resize', width: 300 }]);
        expect([out.width, out.height]).toEqual([300, 300]);
        await expect(runPipeline(solid(), [{ op: 'resize', wdth: 3 }])).rejects.toThrow(/unknown parameter/);
        await expect(runPipeline(solid(), [{ op: 'explode' }])).rejects.toThrow(/unknown op/);
    });
    it('parses colors and rejects junk', () => {
        expect(parseColor('#0A66C2')).toEqual([10, 102, 194, 255]);
        expect(parseColor('transparent')[3]).toBe(0);
        expect(parseColor('rgb(1,2,3)')).toEqual([1, 2, 3, 255]);
        expect(() => parseColor('rainbow')).toThrow(/Unknown color/);
    });
});

describe('codecs', () => {
    it('decodes HEIC (iPhone) photos', async () => {
        const d = await decode(fixture('sample.heic'));
        expect([d.img.width, d.img.height, d.sourceFormat]).toEqual([240, 180, 'heic']);
    });
    it('round-trips every output format', async () => {
        const img = solid(64, 48);
        for (const fmt of ['png', 'jpg', 'webp', 'avif', 'gif', 'tiff', 'bmp'] as const) {
            const back = await decode(await encode(img, fmt));
            expect([back.img.width, back.img.height]).toEqual([64, 48]);
        }
        const ico = await encode(img, 'ico');
        expect(ico.readUInt16LE(2)).toBe(1); // ICO type
        const pdf = await encode(img, 'pdf');
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });
    it('rejects HEIC output with a helpful message', () => {
        expect(() => normalizeFormat('heic')).toThrow(/avif/);
    });
    it('strips JPEG metadata without touching image data', async () => {
        const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
            .jpeg().withExif({ IFD0: { Make: 'TestCam', Model: 'X' } }).toBuffer();
        const before = await decode(jpg);
        expect(before.exif?.fields.Make).toBe('TestCam');
        const stripped = stripJpegMetadata(jpg, 1)!;
        expect(stripped.length).toBeLessThan(jpg.length);
        const sos = (b: Buffer) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
        expect(sos(stripped).equals(sos(jpg))).toBe(true); // scan data identical
        expect((await decode(stripped)).exif).toBeNull();
        expect(stripJpegMetadata(jpg, 6)).toBeNull(); // rotated photos are re-encoded instead
    });
    it('chooses sensible default output formats', () => {
        expect(defaultFormat('heic', solid())).toBe('jpg');
        expect(defaultFormat('jpg', solid(10, 10, [0, 0, 0, 0]))).toBe('png');
        expect(defaultFormat('webp', solid())).toBe('webp');
    });
    it('rejects non-images', async () => {
        await expect(decode(Buffer.from('hello world'))).rejects.toThrow(/Could not read/);
    });
});

describe('upload tokens', () => {
    it('accepts fresh tokens and rejects tampered or expired ones', () => {
        const { token } = makeUploadToken(5);
        expect(verifyUploadToken(token)).toBe(true);
        expect(verifyUploadToken(token.slice(0, -2) + 'xx')).toBe(false);
        expect(verifyUploadToken(makeUploadToken(-1).token)).toBe(false);
        expect(verifyUploadToken('nope')).toBe(false);
    });
});

export { rawCrop, hasAlpha };
