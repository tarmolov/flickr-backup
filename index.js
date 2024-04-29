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

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'secrets.json')).toString());

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

    // https://www.flickr.com/services/api/flickr.photos.getSizes.html
    async getPhotoSizes(photoId) {
        const response = await this._request('flickr.photos.getSizes', {photo_id: photoId});
        return response.sizes.size;
    }

    // https://www.flickr.com/services/api/flickr.photos.getSizes.html
    async getPhotoOriginalSourceUrl(photoId) {
        const sizes = await this.getPhotoSizes(photoId);
        return sizes.find((size) => size.label === 'Original').source;
    }

    async _request(method, params) {
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

    async upload(key, body) {
        const filePath = path.resolve(this._backupDirectory, key);
        await fs.promises.mkdir(path.parse(filePath).dir, {recursive: true});
        await fs.promises.writeFile(filePath, body);
    }
}

const flickrProvider = new FlickrProvider(config.flickr);
const backupStrategies = {
    'yandex-s3': new S3Provider(config.s3),
    'file': new FileProvider('./backup')
};

async function uploadPhoto(strategy, sourceUrl, objectKey) {
    const backupProvider = backupStrategies[strategy];
    logUpdate(chalk.grey.bgYellow(' LOAD '), chalk.white(sourceUrl));
    const isExist = await backupProvider.isObjectExist(objectKey);
    if (isExist) {
        logUpdate(chalk.grey.bgGreenBright(' SKIP '), chalk.white(sourceUrl));
    } else {
        let fimg = await fetch(sourceUrl);
        const body = Buffer.from(await fimg.arrayBuffer());
        await backupProvider.upload(objectKey, body);
        logUpdate(chalk.grey.bgGreen(' DONE '), chalk.white(sourceUrl));
    }
    logUpdate.done();
}

(async () => {
    const loginInfo = await flickrProvider.testLogin();
    const userId = process.env.USER_ID || loginInfo.user.id;

    console.log(chalk.cyan(`Use ${BACKUP_STRATEGY} backup strategy`));
    const photosets = await flickrProvider.getAllPhotosets(userId);

    for (const photoset of photosets.slice(0, 2)) {
        const photosetTitle = photoset.title._content;
        console.log(chalk.magenta(photosetTitle));

        const photos = await flickrProvider.getAllPhotosetPhotos(photoset.id, userId);
        for (const photo of photos) {
            const sourceUrl = await flickrProvider.getPhotoOriginalSourceUrl(photo.id);
            const objectKey = `${photosetTitle}/${path.basename(sourceUrl)}`;
            await uploadPhoto(BACKUP_STRATEGY, sourceUrl, objectKey);
        }
    }
})();
