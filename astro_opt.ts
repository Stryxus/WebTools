import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chokidar from 'chokidar';
import sharp, { type AvifOptions, type PngOptions } from 'sharp';
import { optimize } from 'svgo';
import ttf2woff2 from 'ttf2woff2';

const imageExtensions = ['.png', '.jpg', '.gif']
const audioExtensions = ['.mp3', '.m4a', '.wav', '.flac', '.opus', '.aac'];
const videoExtensions = ['.mp4', '.mov'];
const fontExtensions = ['.ttf', '.woff2']

const watchDir = path.resolve('./public_dev');
const cacheDir = path.resolve('./opt_cache');
await fs.mkdir(cacheDir, { recursive: true });

const execAsync = promisify(exec);
const watcher = chokidar.watch(watchDir, {
    ignored: (filePath: any) => {
        const ext = path.extname(filePath).toLowerCase();
        return ext.length > 0 && (imageExtensions.includes(ext) || audioExtensions.includes(ext) || videoExtensions.includes(ext) || fontExtensions.includes(ext));
    },
    persistent: true,
});

console.log('Initial optimisation pass... Please wait...');
fs.readdir(watchDir, { recursive: true }).then((files: any) => {
    new Promise<void>((resolve) => {
        files.forEach(async (filePath: any, index: number, array: any) => {
            const ext = path.extname(filePath).toLowerCase();
            if (ext.length > 0 && (imageExtensions.includes(ext) || audioExtensions.includes(ext) || videoExtensions.includes(ext) || fontExtensions.includes(ext))) {
                await handleFileChange(path.join(path.resolve('./public_dev'), filePath));
                if (index === array.length -1) resolve();
            }
        });
    }).then(() => {
        watcher
            .on('add', handleFileChange)
            .on('change', handleFileChange) // Chokidar currently has an issue where it can't detect file changes or new files in most scenarios. So must be restarted every time, annoying but has to be done.
            .on('unlink', handleFileDeletion)
            .on('error', error => console.error(`Watcher error: ${error}`));
    });
});

async function handleFileChange(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    try {
        await optimise(filePath, ext);
    } catch (error) {
        console.error(`Error optimizing ${filePath}:`, error);
    }
}

function handleFileDeletion(filePath: string) {
    console.log(`File ${filePath} has been removed`);
}

async function optimise(filePath: string, ext: string) {
    let outputFilePath = path.join(`${filePath.substring(0, filePath.lastIndexOf(path.sep)).replace('/public_dev', '/public')}${path.sep}`, `${path.basename(filePath, ext)}`);
    let relativeInputFilePath = filePath.replace(path.resolve('./'), '');
    let relativeOutputFilePath = outputFilePath.replace(path.resolve('./'), '');
    await fs.mkdir(`${outputFilePath.substring(0, outputFilePath.lastIndexOf(path.sep))}`, { recursive: true }).catch(() => {});
    await fs.unlink(outputFilePath).catch(() => {});
    await fs.mkdir(cacheDir, { recursive: true });

    var beforeSize: number | undefined;
    var afterSize: number | undefined;

    function getDif(): string {
        if (beforeSize && afterSize) {
            const dif = ((beforeSize - afterSize) / beforeSize) * 100;
            return `${dif > 0 ? '\x1b[32m' : dif < 0 ? '\x1b[31m' : ''}[${dif.toFixed(3)}% ${dif > 0 ? 'reduced' : dif < 0 ? 'gained' : ''}]\x1b[0m`
        }
        else return `[DIF ERROR]`;
    }

    try {
        // Process image files
        if (imageExtensions.includes(ext)) {
            console.log(`\x1b[1mQueeing:\x1b[0m ${relativeInputFilePath}`);

            try {
                const format = filePath.substring(path.resolve('./').length).split(path.sep).length - 1 === 2 ? 'png' : 'avif';
                outputFilePath = `${outputFilePath}.${format}`;

                const metadata = await sharp(filePath).metadata();
                const hasAlpha = metadata.hasAlpha || false;
        
                let resizeOptions = {};
                if (metadata.width && metadata.height) {
                    if (metadata.width > 1440 || metadata.height > 1440) {
                        resizeOptions = metadata.width > metadata.height ? { width: 1440 } : { height: 1440 };
                    }
                }

                const pipeline = sharp(filePath).resize(resizeOptions);
                const config: AvifOptions | PngOptions = { quality: format == 'avif' ? 85 : 25, effort: format == 'avif' ? 9 : 10, chromaSubsampling: '4:2:0', progressive: true };

                if (hasAlpha) {
                    const { data: colorData, info: colorInfo, data: alphaData } = await pipeline.raw().toBuffer({ resolveWithObject: true });
                    const combinedBuffer = Buffer.concat([colorData, alphaData]);
                    await sharp(combinedBuffer, {
                        raw: {
                            width: colorInfo.width,
                            height: colorInfo.height,
                            channels: 4, // RGBA
                        },
                    }).toFormat(format, config).toFile(outputFilePath);
                } else {
                    await pipeline.toFormat(format, config).toFile(outputFilePath);
                }

                beforeSize = (await fs.stat(filePath)).size;
                afterSize = (await fs.stat(outputFilePath)).size;
                console.log(`\x1b[1mOptimised:\x1b[0m ${relativeInputFilePath} \x1b[31m[${(beforeSize / 1024).toFixed(3)} KB]\x1b[0m >> ${relativeOutputFilePath}.${format} \x1b[36m[${(afterSize / 1024).toFixed(3)} KB] | ${getDif()}`);
            } catch (error: any) {
                console.error(`Error processing file ${relativeInputFilePath}:`, error.message);
            }
        }
        
        // Process svg files
        else if (ext === '.svg') {
            console.log(`\x1b[1mQueeing:\x1b[0m ${relativeInputFilePath}`);
            await fs.readFile(filePath, { encoding: 'utf-8' }).then(async (data: any) => {
                const result = optimize(data, {
                    multipass: true,
                    floatPrecision: 3,
                });
                await fs.writeFile(`${outputFilePath}.svg`, result.data).then(async () => {
                    beforeSize = (await fs.stat(filePath)).size;
                    afterSize = (await fs.stat(`${outputFilePath}.svg`)).size;
                    console.log(`\x1b[1mOptimised:\x1b[0m ${relativeInputFilePath} \x1b[31m[${(beforeSize / 1024).toFixed(3)} KB]\x1b[0m >> ${relativeOutputFilePath}.svg \x1b[36m[${(afterSize / 1024).toFixed(3)} KB] | ${getDif()}`);
                });
            });
        }

        // Process audio files
        else if (audioExtensions.includes(ext)) {
            console.log(`\x1b[1mQueeing:\x1b[0m ${relativeInputFilePath}`);
            const command = `ffmpeg -i "${filePath}" -c:a libfdk_aac -profile:a aac_he_v2 -b:a 48k -cutoff 18000 -ar 48000 -ac 2 -map_metadata 0 "${outputFilePath}".aac -y`;
            await execAsync(command);
            beforeSize = (await fs.stat(filePath)).size;
            afterSize = (await fs.stat(`${outputFilePath}.aac`)).size;
            console.log(`\x1b[1mOptimised:\x1b[0m ${relativeInputFilePath} \x1b[31m[${(beforeSize / 1024).toFixed(3)} KB]\x1b[0m >> ${relativeOutputFilePath}.aac \x1b[36m[${(afterSize / 1024).toFixed(3)} KB] | ${getDif()}`);
        }

        // Process video files
        else if (videoExtensions.includes(ext)) {
            console.log(`\x1b[1mQueeing:\x1b[0m ${relativeInputFilePath}`);

            // Detect available AV1 encoder based on GPU
            const { stdout: encoders } = await execAsync('ffmpeg -encoders');
            let ffmpegCommand;

            if (encoders.includes('av1_nvenc')) {
                // NVIDIA GPU with AV1 NVENC support
                ffmpegCommand = `ffmpeg -i "${filePath}" -c:v av1_nvenc -preset p7 -cq 30 -b:v 0 "${outputFilePath}".mp4 -y`;
            } else if (encoders.includes('av1_qsv')) {
                // Intel GPU with AV1 QSV support
                ffmpegCommand = `ffmpeg -init_hw_device vaapi=va:/dev/dri/renderD128 -i "${filePath}" -c:v av1_qsv -preset veryslow -q:v 30 -b:v 0 "${outputFilePath}".mp4 -y`;
            } else if (encoders.includes('av1_amf')) {
                // AMD GPU with AV1 AMF support
                ffmpegCommand = `ffmpeg -i "${filePath}" -c:v av1_amf -usage quality -rc vbr_quality -q:v 20 -b:v 0 "${outputFilePath}".mp4 -y`;
            } else {
                // Fallback to CPU-based encoding with libaom
                ffmpegCommand = `ffmpeg -i "${filePath}" -c:v libaom-av1 -crf 30 -b:v 0 -preset slow "${outputFilePath}".mp4 -y`;
            }

            await execAsync(ffmpegCommand);
            beforeSize = (await fs.stat(filePath)).size;
            afterSize = (await fs.stat(`${outputFilePath}.mp4`)).size;
            console.log(`\x1b[1mOptimised:\x1b[0m ${relativeInputFilePath} \x1b[31m[${(beforeSize / 1024).toFixed(3)} KB]\x1b[0m >> ${relativeOutputFilePath}.mp4 \x1b[36m[${(afterSize / 1024).toFixed(3)} KB] | ${getDif()}`);
        }
        
        // Process font files
        else if (fontExtensions.includes(ext)) {
            console.log(`\x1b[1mQueeing:\x1b[0m ${relativeInputFilePath}`);

            if (ext === '.ttf') {
                await fs.readFile(filePath).then(async (data: Buffer<ArrayBufferLike>) => {
                    await fs.writeFile(`${outputFilePath}.woff2`, ttf2woff2(data)).then(async () => {
                        beforeSize = (await fs.stat(filePath)).size;
                        afterSize = (await fs.stat(`${outputFilePath}.woff2`)).size;
                        console.log(`\x1b[1mOptimised:\x1b[0m ${relativeInputFilePath} \x1b[31m[${(beforeSize / 1024).toFixed(3)} KB]\x1b[0m >> ${relativeOutputFilePath}.woff2 \x1b[36m[${(afterSize / 1024).toFixed(3)} KB] | ${getDif()}`);
                    }).catch((err: any) => {
                        console.error(`Unable to write font ${relativeInputFilePath} >> ${relativeOutputFilePath}.woff2\n${err}`);
                    });
                }).catch((err: any) => {
                    console.error(`Unable to read font ${relativeInputFilePath}\n${err}`);
                });
            }
            else if (ext === '.woff2') {
                fs.copyFile(filePath, `${outputFilePath}.woff2`).then(() => {
                    console.log(`Copied font: ${relativeInputFilePath} >> ${relativeOutputFilePath}.woff2`);
                }).catch((err: any) => {
                    console.error(`Unable to copy font ${relativeInputFilePath} >> ${relativeOutputFilePath}.woff2\n${err}`);
                });
            }
        }
    } catch (error: any) {
        await fs.unlink(outputFilePath).catch(() => {});
        console.error(`Error processing file ${relativeInputFilePath}:`, error.message);
    }
}
