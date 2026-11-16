FROM ghcr.io/catthehacker/ubuntu:act-24.04

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
