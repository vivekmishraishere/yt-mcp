declare module 'heic-decode' {
    interface DecodedImage { width: number; height: number; data: Uint8ClampedArray }
    function decode(input: { buffer: Buffer | ArrayBuffer | Uint8Array }): Promise<DecodedImage>;
    export default decode;
}

declare module '@techstark/opencv-js' {
    // OpenCV.js is a dynamic Emscripten module; typed loosely on purpose.
    const cv: any;
    export default cv;
}
