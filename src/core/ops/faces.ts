/**
 * Face detection with OpenCV's classic Haar cascades, running in WebAssembly (OpenCV.js): no native build,
 * no model download. Works on real photos (frontal and profile faces), not on drawings or cartoons.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Img, OpError, flatten, toSharp } from '../img.js';

const require = createRequire(import.meta.url);
const CASCADE_DIR = fileURLToPath(new URL('../../../assets/haarcascades/', import.meta.url));
const CASCADES = ['haarcascade_frontalface_default.xml', 'haarcascade_frontalface_alt2.xml', 'haarcascade_profileface.xml',
    'haarcascade_eye.xml', 'haarcascade_eye_tree_eyeglasses.xml'];

// Wrapped in { cv } on purpose: the Emscripten module has its own .then(), and returning it from an async
// function would make the promise try to adopt it as a thenable and never settle.
let cvReady: Promise<{ cv: any }> | null = null;
const classifiers = new Map<string, any>();

function loadCv(): Promise<{ cv: any }> {
    if (!cvReady) {
        cvReady = (async () => {
            // OpenCV.js (Emscripten) installs global crash handlers that dump its 10 MB source into logs: undo that.
            const before = new Set([...process.listeners('uncaughtException'), ...process.listeners('unhandledRejection')]);
            let cv = require('@techstark/opencv-js');
            for (const ev of ['uncaughtException', 'unhandledRejection'] as const)
                for (const l of process.listeners(ev)) if (!before.has(l)) process.removeListener(ev, l as (...a: any[]) => void);
            if (cv instanceof Promise) cv = await cv;
            // The WASM runtime may finish before or after we look, so poll instead of relying on a callback.
            const started = Date.now();
            while (!(cv.Mat && cv.CascadeClassifier && cv.FS_createDataFile)) {
                if (Date.now() - started > 30_000) throw new Error('OpenCV.js did not initialise within 30s');
                await new Promise(r => setTimeout(r, 25));
            }
            for (const name of CASCADES) {
                try {
                    cv.FS_createDataFile('/', name, fs.readFileSync(CASCADE_DIR + name), true, false, false);
                } catch (e) {
                    if (!String(e).includes('File exists')) throw e;
                }
            }
            return { cv };
        })().catch(e => {
            cvReady = null;
            throw new OpError(`Face detection could not start: ${(e as Error).message}`);
        });
    }
    return cvReady!;
}

function classifier(cv: any, name: string): any {
    let c = classifiers.get(name);
    if (!c) {
        c = new cv.CascadeClassifier();
        if (!c.load(name)) throw new OpError(`Face model ${name} could not be loaded.`);
        classifiers.set(name, c);
    }
    return c;
}

type Box = [number, number, number, number];

function detect(cv: any, mat: any, name: string, neighbors: number, minSize: number): Box[] {
    const rects = new cv.RectVector();
    try {
        classifier(cv, name).detectMultiScale(mat, rects, 1.1, neighbors, 0, new cv.Size(minSize, minSize), new cv.Size(0, 0));
        const out: Box[] = [];
        for (let i = 0; i < rects.size(); i++) {
            const r = rects.get(i);
            out.push([r.x, r.y, r.width, r.height]);
        }
        return out;
    } finally {
        rects.delete();
    }
}

function overlap(a: Box, b: Box): [number, number] {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy, union = a[2] * a[3] + b[2] * b[3] - inter;
    return [union ? inter / union : 0, inter / Math.max(1, Math.min(a[2] * a[3], b[2] * b[3]))];
}

function hasEyes(cv: any, gray: any, [x, y, w, h]: Box): boolean {
    const top = Math.max(0, y), left = Math.max(0, x);
    const rw = Math.min(w, gray.cols - left), rh = Math.min(Math.floor(h * 0.62), gray.rows - top);
    if (rw < 4 || rh < 4) return false;
    const roi = gray.roi(new cv.Rect(left, top, rw, rh));
    const big = new cv.Mat();
    try {
        cv.resize(roi, big, new cv.Size(200, Math.max(1, Math.round((rh * 200) / rw))), 0, 0, cv.INTER_CUBIC);
        return ['haarcascade_eye.xml', 'haarcascade_eye_tree_eyeglasses.xml'].some(n => {
            const rects = new cv.RectVector();
            try {
                classifier(cv, n).detectMultiScale(big, rects, 1.1, 4, 0, new cv.Size(18, 18), new cv.Size(0, 0));
                return rects.size() > 0;
            } finally {
                rects.delete();
            }
        });
    } finally {
        roi.delete();
        big.delete();
    }
}

export interface Face {
    x: number; y: number; width: number; height: number; view: 'frontal' | 'profile'; confidence: 'high' | 'medium';
}

export async function detectFaces(img: Img, sensitivity: 'strict' | 'balanced' | 'loose' = 'balanced', minFace = 0.03): Promise<Face[]> {
    if (!['strict', 'balanced', 'loose'].includes(sensitivity)) throw new OpError("sensitivity must be 'strict', 'balanced' or 'loose'.");
    const { cv } = await loadCv(); // never `return cv` from an async function (see cvReady)
    const s = Math.min(1, 1600 / Math.max(img.width, img.height));
    const { data, info } = await toSharp(flatten(img)).removeAlpha()
        .resize(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), { fit: 'fill' })
        .greyscale().raw().toBuffer({ resolveWithObject: true });
    const gray = cv.matFromArray(info.height, info.width, cv.CV_8UC1, data);
    const flipped = new cv.Mat();
    try {
        cv.equalizeHist(gray, gray);
        const neighbors = { strict: 8, balanced: 5, loose: 3 }[sensitivity];
        const ms = Math.max(20, Math.floor(Math.min(info.width, info.height) * minFace));
        const found: [Box, Face['view']][] = [];
        for (const n of ['haarcascade_frontalface_default.xml', 'haarcascade_frontalface_alt2.xml'])
            for (const b of detect(cv, gray, n, neighbors, ms)) found.push([b, 'frontal']);
        for (const b of detect(cv, gray, 'haarcascade_profileface.xml', neighbors, ms)) found.push([b, 'profile']);
        cv.flip(gray, flipped, 1);
        for (const [x, y, w, h] of detect(cv, flipped, 'haarcascade_profileface.xml', neighbors, ms)) found.push([[info.width - x - w, y, w, h], 'profile']);

        const merged: { box: Box; view: Face['view']; votes: number }[] = [];
        for (const [box, view] of found.sort((a, b) => b[0][2] * b[0][3] - a[0][2] * a[0][3])) {
            const m = merged.find(m => { const [iou, contain] = overlap(box, m.box); return iou > 0.3 || contain > 0.6; });
            if (m) m.votes++;
            else merged.push({ box, view, votes: 1 });
        }
        const kept = merged.filter(m => sensitivity === 'strict' ? m.votes >= 2
            : sensitivity === 'balanced' ? m.votes >= 2 || hasEyes(cv, gray, m.box) : true);
        return kept
            .map(m => ({
                x: Math.round(m.box[0] / s), y: Math.round(m.box[1] / s), width: Math.round(m.box[2] / s), height: Math.round(m.box[3] / s),
                view: m.view, confidence: (m.votes >= 2 ? 'high' : 'medium') as Face['confidence'],
            }))
            .sort((a, b) => b.width * b.height - a.width * a.height);
    } finally {
        gray.delete();
        flipped.delete();
    }
}
