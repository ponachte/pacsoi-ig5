.PHONY: help test service-test image-build experiment

help:
	@node bin/latency-lab.js help

test:
	@npm run test:all

service-test:
	@npm --prefix service test

image-build:
	@docker build -t pacsoi-latency:latest service

experiment:
	@node bin/latency-lab.js experiment
