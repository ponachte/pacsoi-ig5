.PHONY: help test service-test image-build mock-image-build mock-server mock-reset check run experiment

help:
	@node bin/latency-lab.js help

test:
	@npm run test:all

service-test:
	@npm --prefix service test

image-build:
	@docker build -t pacsoi-latency:latest service

mock-image-build:
	@docker build -f mock/Dockerfile -t pacsoi-pod-mock:latest .

mock-server:
	@node mock/pod-server.js

mock-reset:
	@node bin/latency-lab.js mock reset

check:
	@node bin/latency-lab.js check

run:
	@node bin/latency-lab.js run

experiment:
	@node bin/latency-lab.js experiment
