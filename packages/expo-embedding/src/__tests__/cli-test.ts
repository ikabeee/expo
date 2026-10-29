import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Project } from '../xcode';

const exec = promisify(execFile);
const packageRoot = resolve(__dirname, '../..');
let directory: string;
let host: string;
let cli: string;

async function run(...args: string[]) {
  return exec(process.execPath, [cli, ...args], { cwd: host, env: { ...process.env, CI: '1' } });
}

async function contents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (path.isFile()) {
      const absolute = join(path.parentPath, path.name);
      result[absolute.slice(root.length + 1)] = await readFile(absolute, 'utf8');
    }
  }
  return result;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'expo-embedding-cli-'));
  await exec(process.execPath, ['scripts/build.cjs'], { cwd: packageRoot });
  const { stdout } = await exec(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: packageRoot, env: { ...process.env, npm_config_cache: join(directory, 'cache') } }
  );
  await exec('tar', ['-xzf', join(directory, JSON.parse(stdout)[0].filename), '-C', directory]);
  cli = join(directory, 'package/bin/expo-embedding.js');
}, 30000);

beforeEach(async () => {
  host = await realpath(await mkdtemp(join(directory, 'host-')));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('Running the packed CLI outside the Expo checkout', () => {
  it('should show package runner commands before the local Node fallback', async () => {
    const { stdout } = await run('--help');
    expect(stdout).toContain('npx expo-embedding skill');
    expect(stdout).toContain('bunx expo-embedding');
    expect(stdout.indexOf('bunx expo-embedding')).toBeLessThan(stdout.indexOf('node /path/'));
    expect(await readdir(host)).toEqual([]);
  });

  it('should give a SwiftUI agent a validated handoff without changing the host', async () => {
    const project = Project.create();
    project.addTarget('Example', 'com.apple.product-type.application', ['Debug', 'Release']);
    await mkdir(join(host, 'Example.xcodeproj'));
    await writeFile(join(host, 'Example.xcodeproj/project.pbxproj'), project.serialize());
    await writeFile(join(host, 'Example.swift'), 'import SwiftUI\n// Keep the existing app.\n');
    const before = await contents(host);
    const { stdout } = await run('skill', '--json');
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      platform: 'ios',
      root: host,
      selection: { target: 'Example' },
    });
    expect(report.guide).toContain('ExpoBrownfieldAppDelegate');
    expect(report.guide).toContain('ContentView()');
    expect(report.changes).toEqual([]);
    expect((await run('skill')).stdout).toContain('npx expo-embedding init');
    expect(await contents(host)).toEqual(before);
  });

  it('should explain which command accepts the agent output flag before changing files', async () => {
    await expect(run('init', '--json')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--json is only supported by npx expo-embedding skill.'),
    });
    expect(await readdir(host)).toEqual([]);
  });

  it('should preview a Compose host migration in CI without installing or applying it', async () => {
    const fixture: Record<string, string> = {
      'settings.gradle.kts': 'pluginManagement { repositories { google() } }\ninclude(":app")\n',
      'build.gradle.kts': 'plugins {}\n',
      'app/build.gradle.kts': 'plugins {}\nandroid { namespace = "example" }\n',
      'app/src/main/java/example/MainActivity.kt':
        'package example\nimport androidx.activity.ComponentActivity\nclass MainActivity : ComponentActivity() {}\n',
      'app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:theme="@style/Theme.Host">
    <activity android:name=".MainActivity"><intent-filter>
      <action android:name="android.intent.action.MAIN" />
      <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter></activity>
  </application>
</manifest>`,
      'app/src/main/res/values/themes.xml':
        '<resources><style name="Theme.Host" parent="android:Theme.Material.Light.NoActionBar" /></resources>',
    };
    for (const [path, content] of Object.entries(fixture)) {
      await mkdir(join(host, path, '..'), { recursive: true });
      await writeFile(join(host, path), content);
    }
    const report = JSON.parse((await run('skill', '--json')).stdout);
    expect(report).toMatchObject({
      platform: 'android',
      selection: { activity: 'example.MainActivity' },
    });
    expect(report.guide).toContain('PermissionAwareActivity');
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'app/src/main/java/example/MainApplication.kt',
          after: expect.stringContaining('ReactApplication by expo'),
        }),
        expect.objectContaining({
          path: 'app/src/main/java/example/MainActivity.kt',
          after: expect.stringContaining('AppCompatActivity'),
        }),
        expect.objectContaining({
          path: 'app/src/main/AndroidManifest.xml',
          after: expect.stringContaining('android:name="example.MainApplication"'),
        }),
        expect.objectContaining({
          path: 'app/src/main/res/values/themes.xml',
          after: expect.stringContaining('Theme.AppCompat'),
        }),
      ])
    );
    expect(await contents(host)).toEqual(fixture);
    await expect(run('init')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--configure-host'),
      stdout: expect.stringContaining(report.preview),
    });
    expect(await contents(host)).toEqual(fixture);
  });
});
