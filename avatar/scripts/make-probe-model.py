"""Writes tests/fixtures/loudness-probe.onnx: a plumbing fixture for the ONNX Runtime path of the emotion layer.

NOT an emotion model. It maps loudness to "arousal" (clip(4 * rms, 0, 1)) and returns a constant 0.5 for the other
two outputs, in the [arousal, dominance, valence] layout of A/D/V regressors. Lets tests check that audio reaches a
model, the backend loads and the output is read, without shipping a real (licensed, large) model.

    pip install onnx==1.17.0 && python scripts/make-probe-model.py
"""
import os

import onnx
from onnx import TensorProto, helper

x = helper.make_tensor_value_info("waveform", TensorProto.FLOAT, [1, "samples"])
y = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 3])
nodes = [
    helper.make_node("Mul", ["waveform", "waveform"], ["sq"]),
    helper.make_node("ReduceMean", ["sq"], ["ms"], axes=[1], keepdims=1),
    helper.make_node("Sqrt", ["ms"], ["rms"]),
    helper.make_node("Mul", ["rms", "four"], ["scaled"]),
    helper.make_node("Clip", ["scaled", "zero", "one"], ["arousal"]),
    helper.make_node("Concat", ["arousal", "rest"], ["logits"], axis=1),
]
inits = [
    helper.make_tensor("four", TensorProto.FLOAT, [], [4.0]),
    helper.make_tensor("zero", TensorProto.FLOAT, [], [0.0]),
    helper.make_tensor("one", TensorProto.FLOAT, [], [1.0]),
    helper.make_tensor("rest", TensorProto.FLOAT, [1, 2], [0.5, 0.5]),
]
graph = helper.make_graph(nodes, "loudness_probe", [x], [y], inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="prosopon-test")
model.ir_version = 8
onnx.checker.check_model(model)
out = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "loudness-probe.onnx")
onnx.save(model, out)
print("wrote", os.path.normpath(out), os.path.getsize(out), "bytes")
