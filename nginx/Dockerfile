FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    wget \
    build-essential \
    zlib1g-dev \
    libssl-dev \
    libxml2-dev \
    libxslt-dev \
    git \
    libpcre3-dev

# Create nginx user and group
RUN adduser --system --no-create-home --shell /bin/false --group --disabled-login nginx

# Get nginx source
WORKDIR /tmp
RUN wget http://nginx.org/download/nginx-1.25.3.tar.gz && \
    tar -xzvf nginx-1.25.3.tar.gz && \
    rm nginx-1.25.3.tar.gz

# Get and build njs
RUN git clone https://github.com/nginx/njs.git && \
    cd njs && \
    ./configure && \
    make

# Configure and build nginx with njs module
RUN cd /tmp/nginx-1.25.3 && \
    ./configure \
    --prefix=/usr/local/nginx \
    --with-compat \
    --with-pcre \
    --with-pcre-jit \
    --add-dynamic-module=../njs/nginx && \
    make modules && \
    make install

# Copy the built module to nginx modules directory
RUN cp /tmp/nginx-1.25.3/objs/ngx_http_js_module.so /usr/local/nginx/modules/

# Clean up
RUN apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/nginx-1.25.3 /tmp/njs

# Create directory for njs scripts and set ownership
RUN mkdir -p /etc/nginx/njs && \
    mkdir -p /usr/local/nginx/logs && \
    chown -R nginx:nginx /usr/local/nginx/logs

# Add Nginx binary to PATH
ENV PATH="/usr/local/nginx/sbin:${PATH}"

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
