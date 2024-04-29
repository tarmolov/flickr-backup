## Flickr backup
A simple script for backuping photos from Flickr account.

### Available backup destinations
* `yandex-s3` - Yandex Cloud S3
* `file` - Local file system

### Prerequisites
Create `secrets.json`:
```
{
    "flickr": {
        "consumerKey": "",
        "consumerSecret": "",
        "oauthToken": "",
        "oauthTokenSecret": ""
    },
    "s3": {
        "region": "ru-central1",
        "endpoint": "https://storage.yandexcloud.net",
        "bucket": "",
        "credentials": {
            "accessKeyId": "",
            "secretAccessKey": ""
        }
    }
}
```

#### 1. Obtain Flickr Credentials
[Apply for API key](https://www.flickr.com/services/apps/create/apply/) and
```
$ git clone https://github.com/flickr/flickr-sdk.git
$ cd flickr-sdk
$ nvm use 18
$ npm install && npm run build
$ cd examples
$ openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes -subj "/C=XX/ST=StateName/L=CityName/O=CompanyName/OU=CompanySectionName/CN=CommonNameOrHostname"
$ FLICKR_CONSUMER_KEY=<YOUR_APIKEY>  FLICKR_CONSUMER_SECRET=<YOUR_SECRET> node oauth.mjs
```

Save credentials to `secrets.json`:
```
{
    "flickr": {
        "consumerKey": "",
        "consumerSecret": "",
        "oauthToken": "",
        "oauthTokenSecret": ""
    }
}
```

#### 2. Obtain Yandex Cloud S3 Credentials
1. [Create S3 bucket](https://yandex.cloud/ru/docs/storage/quickstart?from=int-console-help-center-or-nav#the-first-bucket).
2. [Do some preparation](https://yandex.cloud/ru/docs/storage/s3/?from=int-console-help-center-or-nav#before-you-start).
3. Append the following section to your `secrets.json`:
```
{
    "s3": {
        "region": "ru-central1",
        "endpoint": "https://storage.yandexcloud.net",
        "bucket": "",
        "credentials": {
            "accessKeyId": "",
            "secretAccessKey": ""
        }
    }
}
```

### Quick start
```
$ git clone git@github.com:tarmolov/flickr-backup.git
$ cd flickr-backup
$ npm install
$ npm start # upload photos to s3
$ BACKUP_STRATEGY=file npm start # download photos locally
$ DEBUG=true npm start # show debug information
```
