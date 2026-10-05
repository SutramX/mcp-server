#!/usr/bin/env node
// Release guard: the tag (argv[2], "v1.2.3") must match package.json,
// src/constants.ts SERVER_VERSION and both versions in server.json; mcpName
// must match the MCP Registry name. Without a tag, only checks that all files
// agree (CI on push / pull_request). GITHUB_REF_NAME is used only when the
// workflow runs for a version tag (GITHUB_REF_TYPE=tag): on a branch it is
// "main" or "12/merge", not a version.
import { readFileSync } from 'node:fs';

const VERSION_TAG = /^v?\d+\.\d+\.\d+/;

function releaseTag() {
    const explicit = (process.argv[2] || '').trim();
    if (explicit) return explicit;
    const ref = (process.env.GITHUB_REF_NAME || '').trim();
    if (process.env.GITHUB_REF_TYPE === 'tag' && VERSION_TAG.test(ref)) return ref;
    return '';
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const constants = /SERVER_VERSION = '([^']+)'/.exec(readFileSync('src/constants.ts', 'utf8'))?.[1];
const tag = releaseTag().replace(/^v/, '');

const versions = {
    'package.json version': pkg.version,
    'src/constants.ts SERVER_VERSION': constants,
    'server.json version': server.version,
    'server.json packages[npm].version': server.packages?.find((item) => item.registryType === 'npm')?.version,
    ...(tag ? { tag } : {}),
};
const problems = [];
if (new Set(Object.values(versions)).size !== 1) problems.push(`versions differ: ${JSON.stringify(versions)}`);
if (pkg.mcpName !== server.name) problems.push(`package.json mcpName ${pkg.mcpName} != server.json name ${server.name}`);
if (server.packages?.find((item) => item.registryType === 'npm')?.identifier !== pkg.name) problems.push('server.json npm identifier != package.json name');
if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
}
console.log(`version ${pkg.version} consistent${tag ? ' with the tag' : ''}`);
