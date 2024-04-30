import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {fileURLToPath} from 'url';
import logUpdate from 'log-update';
import chalk from 'chalk';
import {createFlickr} from 'flickr-sdk'
import * as s3 from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEBUG = process.env.DEBUG;
const BACKUP_STRATEGY = process.env.BACKUP_STRATEGY || 'yandex-s3';
const BACKUP_DIRECTORY = './backup';
const FILTER_PHOTOSETS = process.env.FILTER_PHOTOSETS;
const USE_CACHE = process.env.USE_CACHE;

const configPath = process.env.SECRETS_PATH || path.resolve(__dirname, 'secrets.json');
const config = JSON.parse(fs.readFileSync(configPath).toString());

class FlickrProvider {
    cacheFolder = path.join(__dirname, '.flickr-cache');

    constructor(config) {
        const {flickr} = createFlickr(config);
        this._client = flickr;
    }

    async testLogin() {
        return await this._client('flickr.test.login', {});
    }

    // https://www.flickr.com/services/api/flickr.photosets.getList.html
    async getAllPhotosets(userId) {
        const photosets = [];
        for (let page = 1;; page++) {
            const response = await this._request('flickr.photosets.getList', {page, user_id: userId});
            photosets.push(...response.photosets.photoset);

            if (page === response.photosets.pages) {
                break;
            }
        }
        return photosets;
    }

    // https://www.flickr.com/services/api/flickr.photosets.getPhotos.html
    async getAllPhotosetPhotos(photosetId, userId) {
        const photos = [];
        for (let page = 1;; page++) {
            const response = await this._request('flickr.photosets.getPhotos', {page, photoset_id: photosetId, user_id: userId});
            photos.push(...response.photoset.photo);

            if (page === response.photoset.pages) {
                break;
            }
        }
        return photos;
    }

    // https://www.flickr.com/services/api/flickr.photos.getInfo.html
    async getPhotoInfo(photoId) {
        const response = await this._request('flickr.photos.getInfo', {photo_id: photoId});
        return response.photo;
    }

    // https://www.flickr.com/services/api/flickr.photos.getSizes.html
    async getPhotoSizes(photoId) {
        const response = await this._request('flickr.photos.getSizes', {photo_id: photoId});
        return response.sizes.size;
    }

    // https://www.flickr.com/services/api/flickr.photos.getSizes.html
    async getPhotoOriginalSourceUrl(photoId) {
        const sizes = await this.getPhotoSizes(photoId);
        return (sizes.find((size) => size.label === 'Video Original') ||
            sizes.find((size) => size.lab === 'video' || size.label === 'Original')).source;
    }

    async _request(method, params) {
        if (!USE_CACHE) {
            return await this._client(method, params);
        }

        const cacheKey = crypto.createHash('md5').update(`${method}-${JSON.stringify(params)}`).digest('hex');
        const cacheFilePath = path.join(this.cacheFolder, `${cacheKey}.json`);

        try {
            await fs.promises.access(cacheFilePath);
            DEBUG && console.log(chalk.grey(`USE CACHE FROM ${cacheFilePath}: ${method} with params ${JSON.stringify(params)}`));
            const responseFromCache = await fs.promises.readFile(cacheFilePath);
            return JSON.parse(responseFromCache);
        } catch {
            DEBUG && console.log(chalk.grey(`GET ${method} with params ${JSON.stringify(params)}`));
            const response = await this._client(method, params);
            DEBUG && console.log(chalk.grey(`CACHE ${method} with params ${JSON.stringify(params)}`));
            await fs.promises.mkdir(this.cacheFolder, {recursive: true});
            await fs.promises.writeFile(cacheFilePath, JSON.stringify(response));
            return response;
        }
    }
}

class S3Provider {
    constructor(config) {
        this._config = config;
        this._client = new s3.S3Client(config);
    }

    async isObjectExist(key) {
        const command = new s3.HeadObjectCommand({
            Bucket: this._config.bucket,
            Key: key
        });

        try {
            await this._client.send(command);
            return true;
        } catch (err) {
            if (err.name === 'NotFound') {
                return false;
            } else {
                throw err;
            }
        }
    }

    async listObjects(prefix) {
        let allObjects = [];
        let continuationToken = null;

        do {
            const command = new s3.ListObjectsV2Command({
                Bucket: this._config.bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });
            const data = await this._client.send(command);

            allObjects = allObjects.concat(data.Contents);
            continuationToken = data.NextContinuationToken;
        } while (continuationToken);

        return allObjects;
    }

    async upload(key, body) {
        const command = new s3.PutObjectCommand({
            Bucket: this._config.bucket,
            Key: key,
            Body: body
        });
        return this._client.send(command);
    }
}

class FileProvider {
    constructor(backupDirectory) {
        this._backupDirectory = backupDirectory;
    }

    async isObjectExist(key) {
        try {
            const filePath = path.resolve(this._backupDirectory, key);
            await fs.promises.access(filePath);
            return true;
        } catch (err) {
            return false;
        }
    }

    async listObjects(prefix) {
        const dirPath = path.resolve(this._backupDirectory, prefix);
        try {
            await fs.promises.access(dirPath);
            return await fs.promises.readdir(dirPath);
        } catch (err) {
            return [];
        }
    }

    async upload(key, body) {
        const filePath = path.resolve(this._backupDirectory, key);
        await fs.promises.mkdir(path.parse(filePath).dir, {recursive: true});
        await fs.promises.writeFile(filePath, body);
    }
}

const flickrProvider = new FlickrProvider(config.flickr);
const backupStrategies = {
    'yandex-s3': new S3Provider(config.s3),
    'file': new FileProvider(BACKUP_DIRECTORY)
};
const backupProvider = backupStrategies[BACKUP_STRATEGY];

async function uploadPhoto(sourceUrl, objectKey) {
    logUpdate(chalk.grey.bgYellow(' LOAD '), chalk.white(`${sourceUrl} → ${objectKey}`));
    const isExist = await backupProvider.isObjectExist(objectKey);
    if (isExist) {
        logUpdate(chalk.grey.bgGreenBright(' SKIP '), chalk.white(`${sourceUrl} → ${objectKey}`));
    } else {
        let fimg = await fetch(sourceUrl);
        const body = Buffer.from(await fimg.arrayBuffer());
        await backupProvider.upload(objectKey, body);
        logUpdate(chalk.grey.bgGreen(' DONE '), chalk.white(`${sourceUrl} → ${objectKey}`));
    }
    logUpdate.done();
}

function showNameDuplicates(loginInfo, photos) {
    const photosNames = photos.map((photo) => photo.title).sort();
    const duplicates = photosNames.filter((item, index) => photosNames.indexOf(item) !== index);
    if (duplicates.length) {
        console.log(chalk.red('Duplicates are found:'));
        duplicates.forEach((duplicateTitle) => {
            console.log(chalk.red(duplicateTitle));
            for (const photo of photos) {
                if (photo.title === duplicateTitle) {
                    console.log(chalk.red(`\thttps://flickr.com/photos/${loginInfo.user.path_alias}/${photo.id}`));
                }
            }
        });
    }
}

(async () => {
    const loginInfo = await flickrProvider.testLogin();
    const userId = process.env.USER_ID || loginInfo.user.id;

    console.log([
        chalk.cyan(`Backup strategy:\t${BACKUP_STRATEGY}`),
        BACKUP_STRATEGY === 'yandex-s3' && chalk.cyan(`S3 bucket:\t\t${config.s3.bucket}`),
        BACKUP_STRATEGY === 'file' && chalk.cyan(`Backup directory:\t${BACKUP_DIRECTORY}`),
        chalk.cyan(`Filter photosets:\t${FILTER_PHOTOSETS || 'none'}`),
        chalk.cyan(`Debug mode:\t\t${Boolean(DEBUG)}`),
        '\n'
    ].filter(Boolean).join('\n'));

    const photosets = await flickrProvider.getAllPhotosets(userId);

    for (const photoset of photosets) {
        const photosetTitle = photoset.title._content;
        if (FILTER_PHOTOSETS && !FILTER_PHOTOSETS.includes(photosetTitle)) {
            continue;
        }

        logUpdate(chalk.grey.bgYellow(' LOAD '), chalk.magenta(photosetTitle));

        const photos = await flickrProvider.getAllPhotosetPhotos(photoset.id, userId);
        const remotePhotos = await backupProvider.listObjects(photosetTitle);

        // it's better to compare all objects keys to make sure that photos lists are equal
        // but for my case even such simple conditional works fine
        if (remotePhotos.length === photos.length) {
            logUpdate(chalk.grey.bgGreenBright(' SKIP '), chalk.magenta(photosetTitle));
            logUpdate.done();
            continue;
        }
        logUpdate.done();

        console.log(`Flickr photoset photos: ${photos.length}`);
        console.log(`Backup photoset photos: ${remotePhotos.length}`);
        showNameDuplicates(loginInfo, photos);

        for (const photo of photos) {
            const sourceUrl = await flickrProvider.getPhotoOriginalSourceUrl(photo.id);
            const photoInfo = await flickrProvider.getPhotoInfo(photo.id);

            // flick returns wrong extension for some videos
            const fileExtension = photoInfo.media === 'video' && photoInfo.originalformat === 'jpg' ? 'mov':
                photoInfo.originalformat;
            const fileName = photoInfo.title._content || photoInfo.id;
            const objectKey = `${photosetTitle}/${fileName}.${fileExtension}`;
            await uploadPhoto(sourceUrl, objectKey);
        }
    }
})();
