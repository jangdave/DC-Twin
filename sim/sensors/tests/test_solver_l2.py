"""L2 시험: 가짜 L1과 가짜 예측기로 연결(입력 만들기, 값 바꾸기, 구간·등급 붙이기, 되돌림)을 확인한다. Warp와 scikit-learn은 필요 없다."""
from __future__ import annotations

from types import SimpleNamespace

from dct_sensors.config import Config
from dct_sensors.generator import Generator
from dct_sensors.publish import MqttPublisher
from dct_sensors.scenarios import get
from dct_sensors.solver_l2 import L2Solver, rack_title
from dct_sensors.solvers import Controls, L0Solver


class FakeBase(L0Solver):
    flow_info = {"supply_m3s": 50.0, "aisle_leak_m3s": [1.0, 2.0]}


class FakePredictor:
    def __init__(self, fallback=False):
        self.calls = []
        self.fallback = fallback

    def predict(self, sample, ours, info):
        self.calls.append((sample, dict(ours), info))
        names = list(ours)
        if self.fallback:
            return SimpleNamespace(fallback=True, reason="전력 범위 밖", corrected=dict(ours), lower90=dict(ours), upper90=dict(ours), level={n: "fallback" for n in names})
        return SimpleNamespace(fallback=False, reason="", corrected={n: ours[n] + 1.0 for n in names}, lower90={n: ours[n] + 0.5 for n in names},
                               upper90={n: ours[n] + 1.5 for n in names}, level={n: "caution" for n in names})


class JumpingPredictor(FakePredictor):
    """처음에는 +1, 팬이 멈춘 뒤에는 +5를 보정으로 내는 가짜 예측기."""

    def predict(self, sample, ours, info):
        add = 5.0 if sample["fan"]["CRAC_01"] == 0.0 else 1.0
        names = list(ours)
        return SimpleNamespace(fallback=False, reason="", corrected={n: ours[n] + add for n in names}, lower90={n: ours[n] + add - 0.5 for n in names},
                               upper90={n: ours[n] + add + 0.5 for n in names}, level={n: "ok" for n in names})


class OkPredictor(FakePredictor):
    def predict(self, sample, ours, info):
        names = list(ours)
        return SimpleNamespace(fallback=False, reason="", corrected={n: ours[n] + 1.0 for n in names}, lower90={n: ours[n] for n in names},
                               upper90={n: ours[n] + 2.0 for n in names}, level={n: "ok" for n in names})


def make(manifest, fallback=False):
    cfg = Config()
    pred = FakePredictor(fallback)
    return cfg, pred, L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=pred)


def test_rack_title():
    assert rack_title("rack_07") == "Rack_07"


def test_sample_has_fan_and_row_mean_power(manifest):
    cfg, pred, l2 = make(manifest)
    ctl = Controls({c: 1.0 for c in manifest.cracs} | {"crac_02": 0.0}, {n: 6.0 if manifest.racks[n][0] == 1 else 8.0 for n in manifest.rack_names})
    l2.step(1.0, ctl)
    sample, ours, info = pred.calls[0]
    assert sample["fan"]["CRAC_02"] == 0.0 and sample["fan"]["CRAC_01"] == 1.0
    assert sample["row_power_kw"] == [6.0, 8.0]
    assert set(ours) == {rack_title(n) for n in manifest.rack_names}
    assert info == {"supply_m3s": 50.0, "aisle_leak_m3s": [1.0, 2.0]}


def test_uneven_row_power_caps_confidence_of_that_row(manifest):
    """줄 안에서 랙 하나만 전력이 크게 다르면(학습한 적 없는 조건) 그 줄만 ok -> caution(docs/30 H3)."""
    from dct_sensors.solver_l2 import RACK_SPREAD_KW

    cfg = Config()
    l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=OkPredictor())
    row1 = [n for n in manifest.rack_names if manifest.racks[n][0] == 1]
    power = {n: 8.0 for n in manifest.rack_names}
    power[row1[0]] = 8.0 + RACK_SPREAD_KW * 2  # 한 랙만 크게
    l2.step(1.0, Controls({c: 1.0 for c in manifest.cracs}, power))
    sample = l2.sample_of(Controls({c: 1.0 for c in manifest.cracs}, power))
    assert sample["rack_power_kw"][rack_title(row1[0])] == 8.0 + RACK_SPREAD_KW * 2
    for n in manifest.rack_names:
        want = "caution" if manifest.racks[n][0] == 1 else "ok"
        assert l2.estimates[f"{n}/temp_in"]["confidence"] == want, n
    # 평소 정도의 차이(기본 전력 6~8.5 kW)는 내리지 않는다
    even = {n: 6.0 + 2.5 * (i % 2) for i, n in enumerate(manifest.rack_names)}
    l2.step(1.0, Controls({c: 1.0 for c in manifest.cracs}, even))
    assert all(e["confidence"] == "ok" for e in l2.estimates.values())


def test_only_temp_in_is_corrected_with_estimates(manifest):
    cfg, pred, l2 = make(manifest)
    ctl = Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in manifest.rack_names})
    plain = FakeBase(manifest, cfg).step(1.0, ctl)
    out = l2.step(1.0, ctl)
    for n in manifest.rack_names:
        assert abs(out[f"{n}/temp_in"] - (plain[f"{n}/temp_in"] + 1.0)) < 1e-9
        assert out[f"{n}/temp_out"] == plain[f"{n}/temp_out"]
        e = l2.estimates[f"{n}/temp_in"]
        assert e["lower"] < out[f"{n}/temp_in"] < e["upper"] and e["confidence"] == "caution"
    assert all(k.endswith("/temp_in") for k in l2.estimates)


def test_fallback_keeps_base_values(manifest):
    cfg, pred, l2 = make(manifest, fallback=True)
    ctl = Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in manifest.rack_names})
    plain = FakeBase(manifest, cfg).step(1.0, ctl)
    out = l2.step(1.0, ctl)
    assert all(abs(out[k] - plain[k]) < 1e-9 for k in plain)
    assert {e["confidence"] for e in l2.estimates.values()} == {"fallback"} and l2.fallback_steps == 1


def test_generator_attaches_estimates_to_temp_in_samples_only(manifest):
    cfg, pred, l2 = make(manifest)
    msgs = [m for m in Generator(manifest, get("normal"), l2, cfg, seed=1).run(3) if m["type"] == "sample"]
    for m in msgs:
        has = "confidence" in m
        assert has == m["topic"].endswith("/temp_in")
        if has:
            assert m["lower"] < m["upper"]


def test_mqtt_payload_includes_optional_fields_when_present():
    sent = []
    pub = object.__new__(MqttPublisher)
    pub.c = SimpleNamespace(publish=lambda topic, payload, qos, retain: sent.append(payload))
    pub.send({"type": "sample", "topic": "t", "ts": "x", "value": 1.0, "unit": "degC", "quality": "good", "lower": 0.5, "upper": 1.5, "confidence": "ok"})
    pub.send({"type": "sample", "topic": "t", "ts": "x", "value": 1.0, "unit": "degC", "quality": "good"})
    assert '"confidence":"ok"' in sent[0] and "confidence" not in sent[1]


def test_correction_changes_gradually_not_in_one_step(manifest):
    cfg = Config()
    l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=JumpingPredictor())
    plain = FakeBase(manifest, cfg)
    racks = manifest.rack_names
    ok = Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in racks})
    off = Controls({c: 1.0 for c in manifest.cracs} | {"crac_01": 0.0}, {n: 7.0 for n in racks})
    k = f"{racks[0]}/temp_in"
    l2.step(1.0, ok); plain.step(1.0, ok)
    first = l2.step(1.0, ok)[k] - plain.step(1.0, ok)[k]
    assert abs(first - 1.0) < 1e-6                              # 처음에는 목표 보정량에서 시작
    a = l2.step(1.0, off)[k] - plain.step(1.0, off)[k]
    assert 1.0 < a < 1.2                                       # 한 번에 +5로 뛰지 않는다
    for _ in range(600):
        b = l2.step(1.0, off)[k] - plain.step(1.0, off)[k]
    assert abs(b - 5.0) < 0.05                                 # 충분히 지나면 목표에 닿는다
    e = l2.estimates[k]
    assert abs((e["upper"] - e["lower"]) - 1.0) < 1e-6         # 구간 폭은 예측기가 낸 그대로


def test_supply_shift_is_removed_for_predictor_and_added_back(manifest):
    """급기 온도가 기준과 다르면 예측기에는 기준 온도 기준 값을 넣고, 결과에는 같은 폭을 다시 더한다."""
    cfg = Config(t_supply=22.0)  # 기준(18)보다 4도 높다
    pred = FakePredictor()
    l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=pred)
    ctl = Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in manifest.rack_names})
    plain = FakeBase(manifest, cfg).step(1.0, ctl)
    out = l2.step(1.0, ctl)
    _, seen, _ = pred.calls[-1]
    for n in manifest.rack_names:
        assert abs(seen[rack_title(n)] - (plain[f"{n}/temp_in"] - 4.0)) < 1e-9   # 예측기에는 4도를 뺀 값
        assert abs(out[f"{n}/temp_in"] - (plain[f"{n}/temp_in"] + 1.0)) < 1e-9   # 보정량(+1)은 급기와 무관하게 더해진다
        e = l2.estimates[f"{n}/temp_in"]
        assert e["lower"] < out[f"{n}/temp_in"] < e["upper"]


def test_cooling_power_follows_supply_temperature_assumption(manifest):
    """급기 온도를 올리면 냉각 전력이 줄고(가정 3%/도), 기준에서는 그대로이며 IT 전력은 같다."""
    def agg(t_supply):
        cfg = Config(t_supply=t_supply)
        solver = L0Solver(manifest, cfg)
        gen = Generator(manifest, get("normal"), solver, cfg, seed=1)
        last = {}
        for m in gen.run(3):
            if m["type"] == "aggregate":
                last[m["name"]] = m["value"]
        return last

    base, hot, cold, extreme = agg(18.0), agg(22.0), agg(14.0), agg(60.0)
    assert abs(hot["cooling_power"] / base["cooling_power"] - 0.88) < 0.005
    assert abs(cold["cooling_power"] / base["cooling_power"] - 1.12) < 0.005
    assert abs(extreme["cooling_power"] / base["cooling_power"] - 0.6) < 0.005   # 0.6배에서 멈춘다
    assert abs(hot["it_power"] - base["it_power"]) < 1e-9
    assert hot["pue"] < base["pue"]


def test_cooling_power_follows_it_load_assumption(manifest):
    """부하가 늘면 냉각 전력이 는다(가정: 냉각 전력의 60%가 IT 전력에 비례, 기준은 랙 수 x 7.33 kW에서 1배). 예전에는 부하와 무관하게 고정이었다."""
    def agg(scale):
        cfg = Config(power_base_min=6.0 * scale, power_base_max=8.5 * scale)
        gen = Generator(manifest, get("normal"), L0Solver(manifest, cfg), cfg, seed=1)
        last = {}
        for m in gen.run(3):
            if m["type"] == "aggregate":
                last[m["name"]] = m["value"]
        return last

    lo, base, hi = agg(0.7), agg(1.0), agg(1.3)
    assert lo["it_power"] < base["it_power"] < hi["it_power"]
    assert lo["cooling_power"] < base["cooling_power"] < hi["cooling_power"]
    cfg = Config()
    n_rack, n_crac = len(manifest.rack_names), len(manifest.cracs)
    fixed = n_crac * cfg.cooling_base_kw + cfg.fan_power_kw * n_crac  # 팬 전부 1.0일 때 부하와 무관한 기준값
    ref = cfg.it_ref_per_rack_kw * n_rack
    for a in (lo, base, hi):  # 식 그대로: (1 - 0.6 + 0.6 x IT / 기준)배
        assert abs(a["cooling_power"] - fixed * (0.4 + 0.6 * a["it_power"] / ref)) < 0.01


def test_cooling_load_share_zero_restores_the_old_load_independent_model(manifest):
    cfg = Config(cooling_load_share=0.0, power_base_min=9.0, power_base_max=12.0)
    gen = Generator(manifest, get("normal"), L0Solver(manifest, cfg), cfg, seed=1)
    cool = [m["value"] for m in gen.run(3) if m["type"] == "aggregate" and m["name"] == "cooling_power"]
    fixed = len(manifest.cracs) * (cfg.cooling_base_kw + cfg.fan_power_kw)
    assert all(abs(v - fixed) < 1e-9 for v in cool)


def test_start_message_carries_the_model_provenance_for_l2_only(manifest):
    """L2 녹화의 시작 메시지에 모델 출처가 실린다(어떤 모델로 만든 녹화인지 알 수 있다). 모델이 없는 L0에는 없다."""
    cfg = Config()
    pred = FakePredictor()
    pred.provenance = {"source": "model.pkl", "model_sha256": "abc", "samples_json_sha256": "def", "n_samples": 64, "stale": False}
    l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=pred)
    start = next(iter(Generator(manifest, get("normal"), l2, cfg, seed=1).run(1)))
    assert start["event"] == "start" and start["model"] == pred.provenance
    start0 = next(iter(Generator(manifest, get("normal"), L0Solver(manifest, cfg), cfg, seed=1).run(1)))
    assert "model" not in start0
    assert L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=FakePredictor()).provenance is None  # 출처가 없는 가짜 예측기


def test_shifted_supply_temperature_never_gets_the_top_confidence(manifest):
    """급기 온도가 학습 기준(18도)과 다르면 선형 이동 가정을 쓰므로 ok 등급을 주지 않는다(caution으로 제한). 기준에서는 그대로."""
    class OkPredictor(FakePredictor):
        def predict(self, sample, ours, info):
            names = list(ours)
            return SimpleNamespace(fallback=False, reason="", corrected={n: ours[n] + 1.0 for n in names}, lower90={n: ours[n] + 0.5 for n in names},
                                   upper90={n: ours[n] + 1.5 for n in names}, level={n: "ok" for n in names})

    def levels(t_supply):
        cfg = Config(t_supply=t_supply)
        l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=OkPredictor())
        l2.step(1.0, Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in manifest.rack_names}))
        return {e["confidence"] for e in l2.estimates.values()}

    assert levels(18.0) == {"ok"}
    assert levels(22.0) == {"caution"} and levels(14.0) == {"caution"}


def test_shifted_supply_keeps_lower_levels_as_they_are(manifest):
    cfg = Config(t_supply=22.0)
    pred = FakePredictor()  # 등급 caution을 낸다
    l2 = L2Solver(manifest, cfg, base=FakeBase(manifest, cfg), predictor=pred)
    l2.step(1.0, Controls({c: 1.0 for c in manifest.cracs}, {n: 7.0 for n in manifest.rack_names}))
    assert {e["confidence"] for e in l2.estimates.values()} == {"caution"}


def test_cac_scene_uses_cac_model(manifest, monkeypatch):
    """L1이 냉기 통로 격리(CAC) 장면이라고 판단하면 CAC 결과로 배운 보정 모델을 고른다(docs/34 6장)."""
    import dct_sensors.solver_l2 as l2mod

    asked = []
    monkeypatch.setattr(l2mod, "load_default_predictor", lambda cac=False: asked.append(cac) or OkPredictor())
    cfg = Config()
    hac_base, cac_base = FakeBase(manifest, cfg), FakeBase(manifest, cfg)
    hac_base.lay = SimpleNamespace(cac=False)
    cac_base.lay = SimpleNamespace(cac=True)
    assert not L2Solver(manifest, cfg, base=hac_base).cac
    assert L2Solver(manifest, cfg, base=cac_base).cac
    assert L2Solver(manifest, cfg, base=FakeBase(manifest, cfg)).cac is False  # 장면 정보가 없으면 HAC
    assert asked == [False, True, False]
