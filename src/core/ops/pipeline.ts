/** Run many operations in one go (one decode, one save: no quality loss between steps). */
import { Img, OpError } from '../img.js';
import { blur } from './blur.js';
import { adjust, applyFilter, autoEnhance } from './filters.js';
import { addBorder, cropAspect, cropBox, cropCircle, resize, rotateFlip, roundCorners, socialResize, trimBorders, upscale } from './geometry.js';
import { addText, addWatermark, removeSolidBackground } from './overlay.js';
import { profileRing } from './ring.js';

type Op = { fn: (img: Img, p: any) => Img | Promise<Img>; params: string[] };

export const PIPELINE_OPS: Record<string, Op> = {
    crop: { fn: cropBox, params: ['x', 'y', 'width', 'height'] },
    crop_aspect: { fn: cropAspect, params: ['aspect_ratio', 'focus_x', 'focus_y', 'zoom'] },
    crop_circle: { fn: cropCircle, params: ['size', 'focus_x', 'focus_y', 'zoom', 'border_width', 'border_color', 'background'] },
    profile_ring: { fn: profileRing, params: ['style', 'colors', 'label', 'label_color', 'shape', 'ring_width', 'size', 'focus_x', 'focus_y', 'zoom', 'arc_center', 'arc_span', 'gap', 'background'] },
    resize: { fn: resize, params: ['width', 'height', 'scale', 'fit', 'background'] },
    upscale: { fn: upscale, params: ['factor', 'sharpen'] },
    rotate_flip: { fn: rotateFlip, params: ['angle', 'flip', 'background'] },
    social_resize: { fn: socialResize, params: ['preset', 'fit', 'focus_x', 'focus_y', 'background'] },
    add_border: { fn: addBorder, params: ['width', 'color'] },
    rounded_corners: { fn: roundCorners, params: ['radius'] },
    trim_borders: { fn: trimBorders, params: ['tolerance', 'padding'] },
    apply_filter: { fn: applyFilter, params: ['filter', 'intensity'] },
    adjust: { fn: adjust, params: ['brightness', 'contrast', 'saturation', 'sharpness', 'exposure', 'gamma', 'warmth'] },
    auto_enhance: { fn: autoEnhance, params: ['strength'] },
    blur: { fn: blur, params: ['radius', 'style', 'x', 'y', 'width', 'height', 'regions', 'shape', 'feather', 'invert', 'detect', 'padding', 'sensitivity'] },
    add_text: { fn: addText, params: ['text', 'position', 'font_size', 'color', 'stroke_color', 'stroke_width', 'box_color', 'weight', 'margin', 'max_width'] },
    add_watermark: { fn: (img, p) => addWatermark(img, p), params: ['text', 'position', 'opacity', 'tiled', 'scale', 'color', 'angle'] },
    remove_solid_background: { fn: removeSolidBackground, params: ['color', 'tolerance', 'mode', 'feather'] },
};

export async function runPipeline(img: Img, steps: Record<string, unknown>[]): Promise<Img> {
    if (!steps?.length) throw new OpError('steps is empty. Example: [{"op": "crop_aspect", "aspect_ratio": "1:1"}, {"op": "apply_filter", "filter": "warm"}]');
    if (steps.length > 25) throw new OpError('A pipeline can have at most 25 steps.');
    let out = img;
    for (const [i, step] of steps.entries()) {
        const n = i + 1;
        if (!step || typeof step !== 'object' || typeof step.op !== 'string') throw new OpError(`Step ${n} must be an object with an "op" key.`);
        const op = PIPELINE_OPS[step.op];
        if (!op) throw new OpError(`Step ${n}: unknown op "${step.op}". Options: ${Object.keys(PIPELINE_OPS).join(', ')}.`);
        const params = Object.fromEntries(Object.entries(step).filter(([k]) => k !== 'op'));
        const unknown = Object.keys(params).filter(k => !op.params.includes(k));
        if (unknown.length) throw new OpError(`Step ${n} (${step.op}): unknown parameter(s) ${JSON.stringify(unknown)}. Allowed: ${JSON.stringify(op.params)}.`);
        try {
            out = await op.fn(out, params);
        } catch (e) {
            if (e instanceof OpError) throw new OpError(`Step ${n} (${step.op}): ${e.message}`);
            throw e;
        }
    }
    return out;
}
