import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Building the iOS fixture requires macOS and Xcode.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'artifacts/fixture/JevBench.app');
const cache = resolve(root, 'artifacts/swift-module-cache');
const sdkSelection = process.env.IOS_SIMULATOR_SDK || 'iphonesimulator';
const sdk = isAbsolute(sdkSelection) ? sdkSelection :
  execFileSync('xcrun', ['--sdk', sdkSelection, '--show-sdk-path'], { encoding: 'utf8' }).trim();
const architecture = process.env.IOS_SIMULATOR_ARCH || (process.arch === 'x64' ? 'x86_64' : process.arch);
if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('IOS_SIMULATOR_ARCH must be arm64 or x86_64.');
const deploymentTarget = process.env.IOS_DEPLOYMENT_TARGET || '17.0';
if (!/^\d+\.\d+(?:\.\d+)?$/.test(deploymentTarget) || Number(deploymentTarget.split('.')[0]) < 17) {
  throw new Error('IOS_DEPLOYMENT_TARGET must be an iOS version of 17.0 or later.');
}
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
await writeFile(join(output, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.jev.benchmark</string>
<key>CFBundleExecutable</key><string>JevBench</string>
<key>CFBundleName</key><string>Jev Benchmark</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>${deploymentTarget}</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>UILaunchScreen</key><dict/>
</dict></plist>`);
execFileSync('xcrun', ['swiftc', join(root, 'benchmarks/fixture/main.swift'), '-sdk', sdk,
  '-target', `${architecture}-apple-ios${deploymentTarget}-simulator`, '-module-cache-path', cache,
  '-o', join(output, 'JevBench')], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
console.log(output);
