.PHONY: help test service-test image-build doctor pods slices aggregator service run

help:
	@node bin/latency-lab.js help

test:
	@npm run test:all

service-test:
	@npm --prefix service test

image-build:
	@docker build -t pacsoi-latency:latest service

doctor:
	@node bin/latency-lab.js doctor

pods:
	@node bin/latency-lab.js pods provision

slices:
	@node bin/latency-lab.js slices setup

aggregator:
	@node bin/latency-lab.js aggregator register

service:
	@node bin/latency-lab.js service deploy

run:
	@node bin/latency-lab.js run

cleanup:
	@node bin/latency-lab.js pods cleanup --confirm
