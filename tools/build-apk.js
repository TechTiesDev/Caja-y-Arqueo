/**
 * Generador Autónomo de APK Android (CajaYArqueo-prototipo.apk)
 * Empaqueta el frontend completo con motor autónomo en un APK nativo firmado (v1 JAR Signature PKCS#7),
 * incluyendo AndroidManifest.xml binario (AXML) y bytecode Dalvik (classes.dex) con WebView.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const PROJECT_ROOT = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const OUTPUT_APK = path.join(PROJECT_ROOT, 'CajaYArqueo-prototipo.apk');

/* ============================================================================
   1. GENERADOR DE ANDROIDMANIFEST.XML BINARIO (AXML)
   ============================================================================ */
function buildBinaryAndroidManifest() {
  // Los primeros 10 strings corresponden exactamente a los 10 atributos con Resource ID ordenados
  const attrStrings = [
    { name: 'theme', id: 0x01010000 },
    { name: 'label', id: 0x01010001 },
    { name: 'name', id: 0x01010003 },
    { name: 'exported', id: 0x01010010 },
    { name: 'configChanges', id: 0x0101001f },
    { name: 'minSdkVersion', id: 0x0101020c },
    { name: 'versionCode', id: 0x0101021b },
    { name: 'versionName', id: 0x0101021c },
    { name: 'targetSdkVersion', id: 0x01010270 },
    { name: 'usesCleartextTraffic', id: 0x010104ec },
  ];

  const otherStrings = [
    'android',
    'http://schemas.android.com/apk/res/android',
    '',
    'manifest',
    'package',
    'com.cajayarqueo.prototype',
    '1.0.0',
    'uses-sdk',
    'uses-permission',
    'android.permission.INTERNET',
    'application',
    'Caja y Arqueo',
    'activity',
    'com.cajayarqueo.prototype.MainActivity',
    'intent-filter',
    'action',
    'android.intent.action.MAIN',
    'category',
    'android.intent.category.LAUNCHER',
  ];

  const allStrings = [...attrStrings.map((a) => a.name), ...otherStrings];
  const strIdx = (s) => {
    const i = allStrings.indexOf(s);
    if (i < 0) throw new Error(`String no encontrado en AXML pool: ${s}`);
    return i;
  };

  // Construir String Pool (UTF-16LE)
  const encodedStrings = allStrings.map((str) => {
    const buf = Buffer.alloc(2 + str.length * 2 + 2);
    buf.writeUInt16LE(str.length, 0);
    buf.write(str, 2, 'utf16le');
    buf.writeUInt16LE(0, 2 + str.length * 2);
    return buf;
  });

  const offsets = [];
  let curOffset = 0;
  for (const b of encodedStrings) {
    offsets.push(curOffset);
    curOffset += b.length;
  }
  const stringsDataRaw = Buffer.concat(encodedStrings);
  const padLen = (4 - (stringsDataRaw.length % 4)) % 4;
  const stringsData = Buffer.concat([stringsDataRaw, Buffer.alloc(padLen)]);

  const stringPoolHeaderSize = 28;
  const offsetsSize = allStrings.length * 4;
  const stringsStart = stringPoolHeaderSize + offsetsSize;
  const stringPoolChunkSize = stringsStart + stringsData.length;

  const stringPoolChunk = Buffer.alloc(stringPoolChunkSize);
  stringPoolChunk.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
  stringPoolChunk.writeUInt16LE(stringPoolHeaderSize, 2);
  stringPoolChunk.writeUInt32LE(stringPoolChunkSize, 4);
  stringPoolChunk.writeUInt32LE(allStrings.length, 8);
  stringPoolChunk.writeUInt32LE(0, 12); // styleCount
  stringPoolChunk.writeUInt32LE(0, 16); // flags (UTF-16)
  stringPoolChunk.writeUInt32LE(stringsStart, 20);
  stringPoolChunk.writeUInt32LE(0, 24); // stylesStart
  offsets.forEach((off, idx) => {
    stringPoolChunk.writeUInt32LE(off, 28 + idx * 4);
  });
  stringsData.copy(stringPoolChunk, stringsStart);

  // Construir Resource Map Chunk (0x0180)
  const resMapSize = 8 + attrStrings.length * 4;
  const resMapChunk = Buffer.alloc(resMapSize);
  resMapChunk.writeUInt16LE(0x0180, 0);
  resMapChunk.writeUInt16LE(8, 2);
  resMapChunk.writeUInt32LE(resMapSize, 4);
  attrStrings.forEach((a, idx) => {
    resMapChunk.writeUInt32LE(a.id, 8 + idx * 4);
  });

  const NS_URI = strIdx('http://schemas.android.com/apk/res/android');
  const NS_PREFIX = strIdx('android');
  const NO_NS = 0xffffffff;

  function makeNamespaceChunk(isStart, line = 1) {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(isStart ? 0x0100 : 0x0101, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(NS_PREFIX, 16);
    b.writeUInt32LE(NS_URI, 20);
    return b;
  }

  function makeStartElement(tagName, attrs, line = 1) {
    const totalSize = 36 + attrs.length * 20;
    const b = Buffer.alloc(totalSize);
    b.writeUInt16LE(0x0102, 0); // RES_XML_START_ELEMENT_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(totalSize, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(NO_NS, 16);
    b.writeUInt32LE(strIdx(tagName), 20);
    b.writeUInt16LE(0x0014, 24); // attributeStart
    b.writeUInt16LE(0x0014, 26); // attributeSize
    b.writeUInt16LE(attrs.length, 28); // attributeCount
    b.writeUInt16LE(0, 30);
    b.writeUInt16LE(0, 32);
    b.writeUInt16LE(0, 34);

    attrs.forEach((attr, idx) => {
      const base = 36 + idx * 20;
      b.writeUInt32LE(attr.ns, base);
      b.writeUInt32LE(attr.nameIdx, base + 4);
      b.writeUInt32LE(attr.rawValueIdx, base + 8);
      b.writeUInt16LE(8, base + 12);
      b.writeUInt8(0, base + 14);
      b.writeUInt8(attr.type, base + 15);
      b.writeUInt32LE(attr.data, base + 16);
    });
    return b;
  }

  function makeEndElement(tagName, line = 1) {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(0x0103, 0); // RES_XML_END_ELEMENT_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(NO_NS, 16);
    b.writeUInt32LE(strIdx(tagName), 20);
    return b;
  }

  function attrString(ns, name, val) {
    const vIdx = strIdx(val);
    return { ns, nameIdx: strIdx(name), rawValueIdx: vIdx, type: 0x03, data: vIdx };
  }

  function attrInt(ns, name, intVal) {
    return { ns, nameIdx: strIdx(name), rawValueIdx: 0xffffffff, type: 0x10, data: intVal >>> 0 };
  }

  function attrBool(ns, name, boolVal) {
    return {
      ns,
      nameIdx: strIdx(name),
      rawValueIdx: 0xffffffff,
      type: 0x12,
      data: boolVal ? 0xffffffff : 0x00000000,
    };
  }

  function attrRef(ns, name, resId) {
    return { ns, nameIdx: strIdx(name), rawValueIdx: 0xffffffff, type: 0x01, data: resId >>> 0 };
  }

  const xmlNodes = [
    makeNamespaceChunk(true, 1),

    // <manifest package="com.cajayarqueo.prototype" android:versionCode="2" android:versionName="1.0.0">
    makeStartElement(
      'manifest',
      [
        attrString(NO_NS, 'package', 'com.cajayarqueo.prototype'),
        attrInt(NS_URI, 'versionCode', 2),
        attrString(NS_URI, 'versionName', '1.0.0'),
      ],
      2
    ),

    // <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="28" />
    makeStartElement(
      'uses-sdk',
      [attrInt(NS_URI, 'minSdkVersion', 21), attrInt(NS_URI, 'targetSdkVersion', 28)],
      3
    ),
    makeEndElement('uses-sdk', 3),

    // <uses-permission android:name="android.permission.INTERNET" />
    makeStartElement(
      'uses-permission',
      [attrString(NS_URI, 'name', 'android.permission.INTERNET')],
      4
    ),
    makeEndElement('uses-permission', 4),

    // <application android:theme="@android:style/Theme.Light.NoTitleBar" (0x01030009) android:label="Caja y Arqueo" android:usesCleartextTraffic="true">
    makeStartElement(
      'application',
      [
        attrRef(NS_URI, 'theme', 0x01030009),
        attrString(NS_URI, 'label', 'Caja y Arqueo'),
        attrBool(NS_URI, 'usesCleartextTraffic', true),
      ],
      5
    ),

    // <activity android:name="com.cajayarqueo.prototype.MainActivity" android:exported="true" android:configChanges="0x04a0">
    makeStartElement(
      'activity',
      [
        attrString(NS_URI, 'name', 'com.cajayarqueo.prototype.MainActivity'),
        attrBool(NS_URI, 'exported', true),
        attrInt(NS_URI, 'configChanges', 0x04a0),
      ],
      6
    ),

    makeStartElement('intent-filter', [], 7),
    makeStartElement('action', [attrString(NS_URI, 'name', 'android.intent.action.MAIN')], 8),
    makeEndElement('action', 8),
    makeStartElement('category', [attrString(NS_URI, 'name', 'android.intent.category.LAUNCHER')], 9),
    makeEndElement('category', 9),
    makeEndElement('intent-filter', 7),

    makeEndElement('activity', 6),
    makeEndElement('application', 5),
    makeEndElement('manifest', 2),
    makeNamespaceChunk(false, 10),
  ];

  const body = Buffer.concat([stringPoolChunk, resMapChunk, ...xmlNodes]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);

  return Buffer.concat([header, body]);
}

/* ============================================================================
   2. GENERADOR DE CLASSES.DEX (MainActivity con WebView cargando assets/index.html)
   ============================================================================ */
function writeUleb128(val) {
  const bytes = [];
  let v = val >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function computeAdler32(buf) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function buildClassesDex() {
  const rawStrings = [
    '<init>',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/cajayarqueo/prototype/MainActivity;',
    'Ljava/lang/String;',
    'L',
    'V',
    'VL',
    'VZ',
    'Z',
    'file:///android_asset/index.html',
    'getSettings',
    'loadUrl',
    'onCreate',
    'setAllowFileAccess',
    'setAllowUniversalAccessFromFileURLs',
    'setContentView',
    'setDomStorageEnabled',
    'setJavaScriptEnabled',
    'setWebChromeClient',
    'setWebViewClient',
  ];

  const strings = [...new Set(rawStrings)].sort();
  const sIdx = (s) => {
    const i = strings.indexOf(s);
    if (i < 0) throw new Error(`DEX String faltante: ${s}`);
    return i;
  };

  const typeDescriptors = [
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    'Lcom/cajayarqueo/prototype/MainActivity;',
    'Ljava/lang/String;',
    'V',
    'Z',
  ].sort((a, b) => sIdx(a) - sIdx(b));

  const tIdx = (t) => {
    const i = typeDescriptors.indexOf(t);
    if (i < 0) throw new Error(`DEX Type faltante: ${t}`);
    return i;
  };

  // Protos: ()V, ()WebSettings, (Context)V, (Bundle)V, (View)V, (WebChromeClient)V, (WebViewClient)V, (String)V, (Z)V
  const protoDefs = [
    { key: '()V', shorty: 'V', ret: 'V', params: [] },
    { key: '()WS', shorty: 'L', ret: 'Landroid/webkit/WebSettings;', params: [] },
    { key: '(Ctx)V', shorty: 'VL', ret: 'V', params: ['Landroid/content/Context;'] },
    { key: '(Bdl)V', shorty: 'VL', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { key: '(View)V', shorty: 'VL', ret: 'V', params: ['Landroid/view/View;'] },
    { key: '(WCC)V', shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { key: '(WVC)V', shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { key: '(Str)V', shorty: 'VL', ret: 'V', params: ['Ljava/lang/String;'] },
    { key: '(Z)V', shorty: 'VZ', ret: 'V', params: ['Z'] },
  ].sort((a, b) => {
    const rDiff = tIdx(a.ret) - tIdx(b.ret);
    if (rDiff !== 0) return rDiff;
    const len = Math.min(a.params.length, b.params.length);
    for (let i = 0; i < len; i++) {
      const pDiff = tIdx(a.params[i]) - tIdx(b.params[i]);
      if (pDiff !== 0) return pDiff;
    }
    return a.params.length - b.params.length;
  });

  const pIdx = (k) => protoDefs.findIndex((p) => p.key === k);

  const methodDefs = [
    { key: 'Act.<init>', cls: 'Landroid/app/Activity;', name: '<init>', proto: '()V' },
    { key: 'Act.onCreate', cls: 'Landroid/app/Activity;', name: 'onCreate', proto: '(Bdl)V' },
    { key: 'WCC.<init>', cls: 'Landroid/webkit/WebChromeClient;', name: '<init>', proto: '()V' },
    { key: 'WS.setAllowFileAccess', cls: 'Landroid/webkit/WebSettings;', name: 'setAllowFileAccess', proto: '(Z)V' },
    { key: 'WS.setAllowUniversal', cls: 'Landroid/webkit/WebSettings;', name: 'setAllowUniversalAccessFromFileURLs', proto: '(Z)V' },
    { key: 'WS.setDomStorage', cls: 'Landroid/webkit/WebSettings;', name: 'setDomStorageEnabled', proto: '(Z)V' },
    { key: 'WS.setJs', cls: 'Landroid/webkit/WebSettings;', name: 'setJavaScriptEnabled', proto: '(Z)V' },
    { key: 'WV.<init>', cls: 'Landroid/webkit/WebView;', name: '<init>', proto: '(Ctx)V' },
    { key: 'WV.getSettings', cls: 'Landroid/webkit/WebView;', name: 'getSettings', proto: '()WS' },
    { key: 'WV.loadUrl', cls: 'Landroid/webkit/WebView;', name: 'loadUrl', proto: '(Str)V' },
    { key: 'WV.setWCC', cls: 'Landroid/webkit/WebView;', name: 'setWebChromeClient', proto: '(WCC)V' },
    { key: 'WV.setWVC', cls: 'Landroid/webkit/WebView;', name: 'setWebViewClient', proto: '(WVC)V' },
    { key: 'WVC.<init>', cls: 'Landroid/webkit/WebViewClient;', name: '<init>', proto: '()V' },
    { key: 'Main.<init>', cls: 'Lcom/cajayarqueo/prototype/MainActivity;', name: '<init>', proto: '()V' },
    { key: 'Main.onCreate', cls: 'Lcom/cajayarqueo/prototype/MainActivity;', name: 'onCreate', proto: '(Bdl)V' },
    { key: 'Main.setContentView', cls: 'Lcom/cajayarqueo/prototype/MainActivity;', name: 'setContentView', proto: '(View)V' },
  ].sort((a, b) => {
    const cDiff = tIdx(a.cls) - tIdx(b.cls);
    if (cDiff !== 0) return cDiff;
    const nDiff = sIdx(a.name) - sIdx(b.name);
    if (nDiff !== 0) return nDiff;
    return pIdx(a.proto) - pIdx(b.proto);
  });

  const mIdx = (k) => {
    const i = methodDefs.findIndex((m) => m.key === k);
    if (i < 0) throw new Error(`DEX Method faltante: ${k}`);
    return i;
  };

  // Construir code_item para Main.<init>()V (registers=1, ins=1, outs=1)
  // invoke-direct {v0}, Act.<init> (70 10 mIdxLo mIdxHi 00 00) ; return-void (0e 00)
  const codeInit = Buffer.alloc(16 + 8);
  codeInit.writeUInt16LE(1, 0); // registers_size
  codeInit.writeUInt16LE(1, 2); // ins_size
  codeInit.writeUInt16LE(1, 4); // outs_size
  codeInit.writeUInt16LE(0, 6); // tries_size
  codeInit.writeUInt32LE(0, 8); // debug_info_off
  codeInit.writeUInt32LE(4, 12); // insns_size (in 16-bit units)
  const insInit = [0x1070, mIdx('Act.<init>'), 0x0000, 0x000e];
  insInit.forEach((u, idx) => codeInit.writeUInt16LE(u, 16 + idx * 2));

  // Construir code_item para Main.onCreate(Bundle)V
  // registers=5 (v0=wv, v1=ws, v2=tmp, v3=this/p0, v4=bundle/p1), ins=2, outs=2
  const insOnCreate = [
    // invoke-super {v3, v4}, Act.onCreate
    0x206f, mIdx('Act.onCreate'), 0x0043,
    // new-instance v0, WebView
    0x0022, tIdx('Landroid/webkit/WebView;'),
    // invoke-direct {v0, v3}, WV.<init>(Context)
    0x2070, mIdx('WV.<init>'), 0x0030,
    // invoke-virtual {v0}, WV.getSettings()
    0x106e, mIdx('WV.getSettings'), 0x0000,
    // move-result-object v1
    0x010c,
    // const/4 v2, 1
    0x1212,
    // invoke-virtual {v1, v2}, WS.setJs(Z)
    0x206e, mIdx('WS.setJs'), 0x0021,
    // invoke-virtual {v1, v2}, WS.setDomStorage(Z)
    0x206e, mIdx('WS.setDomStorage'), 0x0021,
    // invoke-virtual {v1, v2}, WS.setAllowFileAccess(Z)
    0x206e, mIdx('WS.setAllowFileAccess'), 0x0021,
    // invoke-virtual {v1, v2}, WS.setAllowUniversal(Z)
    0x206e, mIdx('WS.setAllowUniversal'), 0x0021,
    // new-instance v2, WebViewClient
    0x0222, tIdx('Landroid/webkit/WebViewClient;'),
    // invoke-direct {v2}, WVC.<init>()
    0x1070, mIdx('WVC.<init>'), 0x0002,
    // invoke-virtual {v0, v2}, WV.setWVC
    0x206e, mIdx('WV.setWVC'), 0x0020,
    // new-instance v2, WebChromeClient
    0x0222, tIdx('Landroid/webkit/WebChromeClient;'),
    // invoke-direct {v2}, WCC.<init>()
    0x1070, mIdx('WCC.<init>'), 0x0002,
    // invoke-virtual {v0, v2}, WV.setWCC
    0x206e, mIdx('WV.setWCC'), 0x0020,
    // invoke-virtual {v3, v0}, Main.setContentView(View)
    0x206e, mIdx('Main.setContentView'), 0x0003,
    // const-string v2, "file:///android_asset/index.html"
    0x021a, sIdx('file:///android_asset/index.html'),
    // invoke-virtual {v0, v2}, WV.loadUrl(String)
    0x206e, mIdx('WV.loadUrl'), 0x0020,
    // return-void
    0x000e,
  ];

  const codeOnCreate = Buffer.alloc(16 + insOnCreate.length * 2);
  codeOnCreate.writeUInt16LE(5, 0); // registers_size
  codeOnCreate.writeUInt16LE(2, 2); // ins_size
  codeOnCreate.writeUInt16LE(2, 4); // outs_size
  codeOnCreate.writeUInt16LE(0, 6); // tries_size
  codeOnCreate.writeUInt32LE(0, 8); // debug_info_off
  codeOnCreate.writeUInt32LE(insOnCreate.length, 12);
  insOnCreate.forEach((u, idx) => codeOnCreate.writeUInt16LE(u, 16 + idx * 2));

  // Layout de secciones DEX
  const headerSize = 0x70;
  const stringIdsSize = strings.length * 4;
  const typeIdsSize = typeDescriptors.length * 4;
  const protoIdsSize = protoDefs.length * 12;
  const methodIdsSize = methodDefs.length * 8;
  const classDefsSize = 32;

  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + stringIdsSize;
  const protoIdsOff = typeIdsOff + typeIdsSize;
  const methodIdsOff = protoIdsOff + protoIdsSize;
  const classDefsOff = methodIdsOff + methodIdsSize;
  const dataOff = classDefsOff + classDefsSize;

  const dataChunks = [];
  let currentOff = dataOff;

  function pushAligned(buf, align = 4) {
    const pad = (align - (currentOff % align)) % align;
    if (pad > 0) {
      dataChunks.push(Buffer.alloc(pad));
      currentOff += pad;
    }
    const off = currentOff;
    dataChunks.push(buf);
    currentOff += buf.length;
    return off;
  }

  // 1. type_lists para protos con parámetros
  const protoParamOffsets = protoDefs.map((p) => {
    if (p.params.length === 0) return 0;
    const b = Buffer.alloc(4 + p.params.length * 2);
    b.writeUInt32LE(p.params.length, 0);
    p.params.forEach((pt, i) => b.writeUInt16LE(tIdx(pt), 4 + i * 2));
    return pushAligned(b, 4);
  });

  // 2. code_items
  const codeInitOff = pushAligned(codeInit, 4);
  const codeOnCreateOff = pushAligned(codeOnCreate, 4);

  // 3. string_data_items
  const stringDataOffsets = strings.map((s) => {
    const utf8 = Buffer.from(s, 'utf8');
    const item = Buffer.concat([writeUleb128(s.length), utf8, Buffer.from([0])]);
    return pushAligned(item, 1);
  });

  // 4. class_data_item para MainActivity
  const classDataBuf = Buffer.concat([
    writeUleb128(0), // static_fields_size
    writeUleb128(0), // instance_fields_size
    writeUleb128(1), // direct_methods_size (Main.<init>)
    writeUleb128(1), // virtual_methods_size (Main.onCreate)
    // direct_method[0]: Main.<init>, ACC_PUBLIC | ACC_CONSTRUCTOR (0x10001)
    writeUleb128(mIdx('Main.<init>')),
    writeUleb128(0x10001),
    writeUleb128(codeInitOff),
    // virtual_method[0]: Main.onCreate, ACC_PUBLIC (0x0001)
    writeUleb128(mIdx('Main.onCreate')),
    writeUleb128(0x0001),
    writeUleb128(codeOnCreateOff),
  ]);
  const classDataOff = pushAligned(classDataBuf, 1);

  // 5. map_list (obligatorio al final de la sección data)
  const mapOff = pushAligned(Buffer.alloc(0), 4);
  const mapItems = [
    { type: 0x0000, size: 1, offset: 0 }, // HEADER
    { type: 0x0001, size: strings.length, offset: stringIdsOff },
    { type: 0x0002, size: typeDescriptors.length, offset: typeIdsOff },
    { type: 0x0003, size: protoDefs.length, offset: protoIdsOff },
    { type: 0x0005, size: methodDefs.length, offset: methodIdsOff },
    { type: 0x0006, size: 1, offset: classDefsOff },
    { type: 0x1001, size: protoDefs.filter((p) => p.params.length > 0).length, offset: protoParamOffsets.find((o) => o > 0) },
    { type: 0x2001, size: 2, offset: codeInitOff },
    { type: 0x2002, size: strings.length, offset: stringDataOffsets[0] },
    { type: 0x2000, size: 1, offset: classDataOff },
    { type: 0x1000, size: 1, offset: mapOff },
  ];
  const mapBuf = Buffer.alloc(4 + mapItems.length * 12);
  mapBuf.writeUInt32LE(mapItems.length, 0);
  mapItems.forEach((m, i) => {
    const base = 4 + i * 12;
    mapBuf.writeUInt16LE(m.type, base);
    mapBuf.writeUInt16LE(0, base + 2);
    mapBuf.writeUInt32LE(m.size, base + 4);
    mapBuf.writeUInt32LE(m.offset, base + 8);
  });
  pushAligned(mapBuf, 4);

  const fileSize = currentOff;
  const dataSize = fileSize - dataOff;

  // Ensamblar tablas de índices
  const stringIdsBuf = Buffer.alloc(stringIdsSize);
  stringDataOffsets.forEach((off, i) => stringIdsBuf.writeUInt32LE(off, i * 4));

  const typeIdsBuf = Buffer.alloc(typeIdsSize);
  typeDescriptors.forEach((td, i) => typeIdsBuf.writeUInt32LE(sIdx(td), i * 4));

  const protoIdsBuf = Buffer.alloc(protoIdsSize);
  protoDefs.forEach((p, i) => {
    const base = i * 12;
    protoIdsBuf.writeUInt32LE(sIdx(p.shorty), base);
    protoIdsBuf.writeUInt32LE(tIdx(p.ret), base + 4);
    protoIdsBuf.writeUInt32LE(protoParamOffsets[i], base + 8);
  });

  const methodIdsBuf = Buffer.alloc(methodIdsSize);
  methodDefs.forEach((m, i) => {
    const base = i * 8;
    methodIdsBuf.writeUInt16LE(tIdx(m.cls), base);
    methodIdsBuf.writeUInt16LE(pIdx(m.proto), base + 2);
    methodIdsBuf.writeUInt32LE(sIdx(m.name), base + 4);
  });

  const classDefsBuf = Buffer.alloc(32);
  classDefsBuf.writeUInt32LE(tIdx('Lcom/cajayarqueo/prototype/MainActivity;'), 0);
  classDefsBuf.writeUInt32LE(0x0001, 4); // ACC_PUBLIC
  classDefsBuf.writeUInt32LE(tIdx('Landroid/app/Activity;'), 8);
  classDefsBuf.writeUInt32LE(0, 12); // interfaces_off
  classDefsBuf.writeUInt32LE(0xffffffff, 16); // source_file_idx
  classDefsBuf.writeUInt32LE(0, 20); // annotations_off
  classDefsBuf.writeUInt32LE(classDataOff, 24);
  classDefsBuf.writeUInt32LE(0, 28); // static_values_off

  const headerBuf = Buffer.alloc(headerSize);
  headerBuf.write('dex\n035\0', 0, 'ascii');
  headerBuf.writeUInt32LE(fileSize, 32);
  headerBuf.writeUInt32LE(headerSize, 36);
  headerBuf.writeUInt32LE(0x12345678, 40); // ENDIAN_CONSTANT
  headerBuf.writeUInt32LE(0, 44); // link_size
  headerBuf.writeUInt32LE(0, 48); // link_off
  headerBuf.writeUInt32LE(mapOff, 52);
  headerBuf.writeUInt32LE(strings.length, 56);
  headerBuf.writeUInt32LE(stringIdsOff, 60);
  headerBuf.writeUInt32LE(typeDescriptors.length, 64);
  headerBuf.writeUInt32LE(typeIdsOff, 68);
  headerBuf.writeUInt32LE(protoDefs.length, 72);
  headerBuf.writeUInt32LE(protoIdsOff, 76);
  headerBuf.writeUInt32LE(0, 80); // field_ids_size
  headerBuf.writeUInt32LE(0, 84); // field_ids_off
  headerBuf.writeUInt32LE(methodDefs.length, 88);
  headerBuf.writeUInt32LE(methodIdsOff, 92);
  headerBuf.writeUInt32LE(1, 96); // class_defs_size
  headerBuf.writeUInt32LE(classDefsOff, 100);
  headerBuf.writeUInt32LE(dataSize, 104);
  headerBuf.writeUInt32LE(dataOff, 108);

  const fullDex = Buffer.concat([
    headerBuf,
    stringIdsBuf,
    typeIdsBuf,
    protoIdsBuf,
    methodIdsBuf,
    classDefsBuf,
    ...dataChunks,
  ]);

  // Calcular SHA-1 de bytes [32..end] y Adler32 de bytes [12..end]
  const sha1 = crypto.createHash('sha1').update(fullDex.subarray(32)).digest();
  sha1.copy(fullDex, 12);
  const adler = computeAdler32(fullDex.subarray(12));
  fullDex.writeUInt32LE(adler, 8);

  return fullDex;
}

/* ============================================================================
   3. FIRMA CRIPTOGRÁFICA JAR v1 (META-INF/MANIFEST.MF, CERT.SF, CERT.RSA PKCS#7)
   ============================================================================ */
function derLen(len) {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derNode(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items) {
  return derNode(0x30, Buffer.concat(items));
}

function derSet(...items) {
  return derNode(0x31, Buffer.concat(items));
}

function derOid(bytes) {
  return derNode(0x06, Buffer.from(bytes));
}

function derInt(numOrBuf) {
  if (typeof numOrBuf === 'number') return derNode(0x02, Buffer.from([numOrBuf]));
  const b = Buffer.isBuffer(numOrBuf) ? numOrBuf : Buffer.from(numOrBuf);
  return derNode(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function getOrCreateKeypair() {
  const keyPath = path.join(__dirname, '.apk-signing-key.json');
  if (fs.existsSync(keyPath)) {
    const saved = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return {
      privateKey: crypto.createPrivateKey(saved.privateKey),
      publicKey: crypto.createPublicKey(saved.publicKey),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    }),
    'utf8'
  );
  return { privateKey, publicKey };
}

function buildSelfSignedPKCS7(sfBuffer) {
  const { privateKey, publicKey } = getOrCreateKeypair();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // OIDs
  const oidSha256WithRSA = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
  const oidSha256 = derOid([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
  const oidRsaEncryption = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const oidCommonName = derOid([0x55, 0x04, 0x03]);
  const oidSignedData = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
  const oidData = derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
  const derNull = Buffer.from([0x05, 0x00]);

  const algSha256Rsa = derSeq(oidSha256WithRSA, derNull);
  const algSha256 = derSeq(oidSha256, derNull);
  const algRsa = derSeq(oidRsaEncryption, derNull);

  const cnVal = derNode(0x0c, Buffer.from('Caja y Arqueo Prototype', 'utf8'));
  const rdnName = derSeq(derSet(derSeq(oidCommonName, cnVal)));
  const serialNum = derInt(1);

  const notBefore = derNode(0x17, Buffer.from('250101000000Z', 'ascii'));
  const notAfter = derNode(0x17, Buffer.from('491231235959Z', 'ascii'));
  const validity = derSeq(notBefore, notAfter);

  const tbsCert = derSeq(
    derNode(0xa0, derInt(2)), // v3
    serialNum,
    algSha256Rsa,
    rdnName,
    validity,
    rdnName,
    spkiDer
  );

  const certSig = crypto.sign('sha256', tbsCert, privateKey);
  const certDer = derSeq(
    tbsCert,
    algSha256Rsa,
    derNode(0x03, Buffer.concat([Buffer.from([0x00]), certSig]))
  );

  // Firmar CERT.SF para el SignerInfo de PKCS#7
  const sfSignature = crypto.sign('sha256', sfBuffer, privateKey);

  const signerInfo = derSeq(
    derInt(1),
    derSeq(rdnName, serialNum),
    algSha256,
    algRsa,
    derNode(0x04, sfSignature)
  );

  const signedData = derSeq(
    derInt(1),
    derSet(algSha256),
    derSeq(oidData),
    derNode(0xa0, certDer),
    derSet(signerInfo)
  );

  return derSeq(oidSignedData, derNode(0xa0, signedData));
}

/* ============================================================================
   4. EMPAQUETADOR ZIP / APK
   ============================================================================ */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.data;
    const crc = crc32(uncompressed);
    const compressed = zlib.deflateRawSync(uncompressed);
    const useDeflate = compressed.length < uncompressed.length;
    const payload = useDeflate ? compressed : uncompressed;
    const method = useDeflate ? 8 : 0;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5621, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5621, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function buildSelfContainedHtml() {
  let html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf8');
  const engineJs = fs.readFileSync(path.join(FRONTEND_DIR, 'standalone-engine.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(FRONTEND_DIR, 'app.js'), 'utf8');

  // Incrustar CSS y JS directamente en index.html para evitar bloqueos de subrecursos file:// en Android WebView
  html = html.replace(/<link\s+rel="manifest"[^>]*>/i, '');
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="[^"]*styles\.css"\s*\/?>/i,
    () => `<style>\n${css}\n</style>`
  );
  html = html.replace(
    /<script\s+src="[^"]*standalone-engine\.js"><\/script>/i,
    ''
  );
  html = html.replace(
    /<script\s+src="[^"]*app\.js"><\/script>/i,
    () => `<script>\n${engineJs}\n\n${appJs}\n</script>`
  );

  return Buffer.from(html, 'utf8');
}

function buildApk() {
  const manifestXml = buildBinaryAndroidManifest();
  const classesDex = buildClassesDex();
  const inlinedIndexHtml = buildSelfContainedHtml();

  const filesToBundle = [
    { name: 'AndroidManifest.xml', data: manifestXml },
    { name: 'classes.dex', data: classesDex },
    { name: 'assets/index.html', data: inlinedIndexHtml },
  ];

  // Construir META-INF/MANIFEST.MF
  const mfSections = [];
  let mfContent = 'Manifest-Version: 1.0\r\nCreated-By: CajaYArqueo Builder 1.0\r\n\r\n';
  for (const f of filesToBundle) {
    const digest = crypto.createHash('sha256').update(f.data).digest('base64');
    const sec = `Name: ${f.name}\r\nSHA-256-Digest: ${digest}\r\n\r\n`;
    mfSections.push({ name: f.name, section: sec });
    mfContent += sec;
  }
  const mfBuf = Buffer.from(mfContent, 'utf8');

  // Construir META-INF/CERT.SF
  const mainManifestDigest = crypto.createHash('sha256').update(mfBuf).digest('base64');
  let sfContent = `Signature-Version: 1.0\r\nCreated-By: CajaYArqueo Signer\r\nSHA-256-Digest-Manifest: ${mainManifestDigest}\r\n\r\n`;
  for (const s of mfSections) {
    const secDigest = crypto.createHash('sha256').update(Buffer.from(s.section, 'utf8')).digest('base64');
    sfContent += `Name: ${s.name}\r\nSHA-256-Digest: ${secDigest}\r\n\r\n`;
  }
  const sfBuf = Buffer.from(sfContent, 'utf8');

  // Construir META-INF/CERT.RSA
  const rsaBuf = buildSelfSignedPKCS7(sfBuf);

  const allEntries = [
    ...filesToBundle,
    { name: 'META-INF/MANIFEST.MF', data: mfBuf },
    { name: 'META-INF/CERT.SF', data: sfBuf },
    { name: 'META-INF/CERT.RSA', data: rsaBuf },
  ];

  const apkBuffer = createZipArchive(allEntries);
  fs.writeFileSync(OUTPUT_APK, apkBuffer);
  console.log(`APK generado exitosamente en: ${OUTPUT_APK} (${apkBuffer.length} bytes)`);
}

if (require.main === module) {
  buildApk();
}

module.exports = { buildApk };
