// 후처리: 장면을 한 번 더 거쳐 빛 번짐(표시등, 알람, 저녁 창)과 접촉 그림자(SSAO, 높음 단계)를 더한다. 톤 매핑은 마지막 OutputPass가 한다.
// 장면 코드와 분리해 둔 이유: 낮은 단계나 자동 시험에서는 통째로 끄고, 켜고 끄는 일이 장면 구조를 건드리지 않게 하려는 것이다.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export class Fx {
  // opts: { bloom: 세기(0~1), ao: 접촉 그림자 여부 }
  constructor(renderer, scene, camera, { bloom = 0.3, ao = false } = {}) {
    this.renderer = renderer;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }); // 색 범위가 넓은 중간 결과 + 계단 현상 제거
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = null;
    if (ao) {
      this.ao = new GTAOPass(scene, camera, 1, 1);
      this.ao.output = GTAOPass.OUTPUT.Default;
      this.composer.addPass(this.ao);
    }
    // 문턱 0.95: 밝게 칠한 것(표시등, 켜진 창, 알람 색)만 번지고 일반 면은 번지지 않는다
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), bloom, 0.45, 0.95);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(Math.max(w * pixelRatio * 0.5, 1), Math.max(h * pixelRatio * 0.5, 1)); // 번짐은 절반 해상도로 그린다(비용 절약)
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
  }
}
