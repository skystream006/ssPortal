FROM php:8.5-apache AS php-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip git libicu-dev libonig-dev libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev libsqlite3-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" gd intl mbstring pdo_sqlite pdo_mysql zip exif \
    && a2enmod rewrite headers expires \
    && printf 'ServerName localhost\n' > /etc/apache2/conf-available/server-name.conf \
    && a2enconf server-name \
    && mkdir -p /var/www/empty \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/php/php.ini /usr/local/etc/php/conf.d/portal.ini
COPY --chmod=755 deploy/php/entrypoint.sh /usr/local/bin/portal-php-entrypoint
ENTRYPOINT ["portal-php-entrypoint"]
CMD ["apache2-foreground"]

FROM node:24-alpine AS grocy-assets
WORKDIR /build
RUN apk add --no-cache git
COPY grocy/package*.json ./
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund

FROM node:24-alpine AS webtrees-assets
WORKDIR /build
COPY webtrees/package*.json ./
RUN npm install --no-audit --no-fund
COPY webtrees/webpack.config.js ./
COPY webtrees/resources ./resources
RUN npm run build

FROM php-runtime AS grocy-source
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /build
COPY grocy/ ./
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress --no-scripts

FROM php-runtime AS webtrees-source
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /build
COPY webtrees/ ./
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress --no-scripts \
    && php index.php dev:compile-po-files --no-interaction

FROM php-runtime AS grocy
COPY --from=grocy-source /build/ /var/www/grocy/
COPY --from=grocy-assets /build/node_modules/ /var/www/grocy/public/packages/
COPY deploy/php/grocy.conf /etc/apache2/sites-available/000-default.conf
ENV APP_NAME=grocy APP_DATA_DIR=/var/www/grocy/data
WORKDIR /var/www/grocy
RUN mkdir -p data && chown www-data:www-data data

FROM php-runtime AS webtrees
COPY --from=webtrees-source /build/ /var/www/webtrees/
COPY --from=webtrees-assets /build/public/ /var/www/webtrees/public/
COPY --from=webtrees-assets /build/resources/fonts/ /var/www/webtrees/resources/fonts/
COPY deploy/php/webtrees.conf /etc/apache2/sites-available/000-default.conf
ENV APP_NAME=webtrees APP_DATA_DIR=/var/www/webtrees/data
WORKDIR /var/www/webtrees
RUN mkdir -p data && chown www-data:www-data data
