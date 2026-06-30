"""VST3 plugin host — manages loaded plugin instances via pedalboard.

In-process hosting: pedalboard runs inside the same Python process.
Each loaded plugin gets a unique instance_id (UUID). Thread-safe via
pedalboard's GIL-releasing architecture.
"""

from __future__ import annotations
import logging
import uuid
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

# Lazy import — pedalboard is heavy and may not be installed in dev
_pedalboard: Any = None


def _get_pedalboard():
    global _pedalboard
    if _pedalboard is None:
        import pedalboard

        _pedalboard = pedalboard
    return _pedalboard


class VstInstance:
    """A loaded VST3 plugin instance."""

    def __init__(
        self, instance_id: str, plugin_path: str, plugin_name: str, plugin: Any
    ):
        self.instance_id = instance_id
        self.plugin_path = plugin_path
        self.plugin_name = plugin_name
        self._plugin = plugin

    @property
    def parameters(self) -> dict[str, float]:
        return dict(self._plugin.parameters)

    def set_parameter(self, name: str, value: float) -> None:
        self._plugin.parameters[name] = value

    def process(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        return self._plugin(audio, sample_rate)

    def reset(self) -> None:
        self._plugin.reset()


# Global registry of loaded instances
_instances: dict[str, VstInstance] = {}


def load_plugin(plugin_path: str, instance_id: str | None = None) -> VstInstance:
    """Load a VST3 plugin and register it. Returns a VstInstance."""
    pb = _get_pedalboard()
    path = Path(plugin_path)
    if not path.exists():
        raise FileNotFoundError(f"VST3 plugin not found: {plugin_path}")

    plugin = pb.load_plugin(str(path))
    iid = instance_id or str(uuid.uuid4())
    inst = VstInstance(
        instance_id=iid, plugin_path=str(path), plugin_name=path.stem, plugin=plugin
    )
    _instances[iid] = inst
    log.info("Loaded VST3 '%s' as instance %s", inst.plugin_name, iid)
    return inst


def unload_plugin(instance_id: str) -> None:
    """Unload and remove a plugin instance."""
    inst = _instances.pop(instance_id, None)
    if inst is None:
        raise KeyError(f"No VST instance with id: {instance_id}")
    inst.reset()
    log.info("Unloaded VST3 instance %s", instance_id)


def get_instance(instance_id: str) -> VstInstance:
    if instance_id not in _instances:
        raise KeyError(f"No VST instance with id: {instance_id}")
    return _instances[instance_id]


def list_instances() -> list[dict]:
    """List all loaded instances as serializable dicts."""
    return [
        {
            "instance_id": v.instance_id,
            "plugin_name": v.plugin_name,
            "plugin_path": v.plugin_path,
            "parameters": v.parameters,
        }
        for v in _instances.values()
    ]


def process_chain(
    instance_ids: list[str], audio: np.ndarray, sample_rate: int
) -> np.ndarray:
    """Process audio through an ordered chain of loaded VST instances."""
    result = audio
    for iid in instance_ids:
        inst = get_instance(iid)
        result = inst.process(result, sample_rate)
    return result


def process_with_plugin(
    plugin_path: str,
    audio: np.ndarray,
    sample_rate: int,
    params: dict[str, float] | None = None,
) -> np.ndarray:
    """Process audio through a single VST3 plugin, statelessly.

    The plugin is loaded fresh, optional parameters are applied best-effort,
    the audio is processed, and the plugin is discarded (it is never added to
    the instance registry). This mirrors the studio effect pipeline so a VST3
    can be one stage of the MIX effect chain.
    """
    pb = _get_pedalboard()
    path = Path(plugin_path)
    if not path.exists():
        raise FileNotFoundError(f"VST3 plugin not found: {plugin_path}")
    plugin = pb.load_plugin(str(path))
    if params:
        for name, value in params.items():
            try:
                plugin.parameters[name] = float(value)
            except Exception:
                # Unknown parameter name or unsupported value — skip it.
                log.debug("VST param '%s' could not be set on %s", name, path.stem)
    return plugin(audio, sample_rate)


# Container / abstract / non-effect pedalboard classes to exclude from the
# built-in effect list (they are not stand-alone processors).
_NON_EFFECT_PLUGINS = {
    "Plugin",
    "Pedalboard",
    "ExternalPlugin",
    "VST3Plugin",
    "AudioUnitPlugin",
    "PluginContainer",
    "Chain",
    "Mix",
    "AudioStream",
    # Abstract base for the shelf/peak filters; cannot be instantiated directly.
    "IIRFilter",
}


def list_builtin_effects() -> list[dict]:
    """List pedalboard's built-in effects (available without any VST3).

    Introspected from the installed pedalboard rather than hardcoded, so the
    list never drifts from the version actually present.
    """
    pb = _get_pedalboard()
    plugin_base = pb.Plugin
    names = sorted(
        n
        for n in dir(pb)
        if not n.startswith("_")
        and n not in _NON_EFFECT_PLUGINS
        and isinstance(getattr(pb, n), type)
        and issubclass(getattr(pb, n), plugin_base)
    )
    return [{"name": name, "type": "builtin"} for name in names]
