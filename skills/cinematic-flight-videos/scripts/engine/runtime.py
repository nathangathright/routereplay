"""Per-process immutable render inputs, set by the CLI before importing layers."""
import json
import os
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))
from trip import load_trip

TRIP = load_trip(Path(os.environ['FLIGHT_TRIP']))
ASSETS = Path(os.environ['FLIGHT_ASSET_DIR'])
BUNDLE = json.loads((ASSETS / 'bundle.json').read_text())
WORK = Path(os.environ['FLIGHT_WORK_DIR'])
AIRCRAFT_MODE = os.environ.get('FLIGHT_AIRCRAFT_MODE', 'cycles')
AIRCRAFT_DIR = WORK / 'aircraft'
WEATHER = (json.loads((ASSETS / BUNDLE['weather']['runtime_path']).read_text())
           if TRIP.weather['mode'] != 'clear' else None)


def asset(name):
    return ASSETS / BUNDLE['assets'][name]['path']
