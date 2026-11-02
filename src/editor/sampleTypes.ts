// Test helper: register the Flappy sample's types (ADR 0031), as loading the project's scripts
// would. Editor tests that open the sample's scenes import this (testing.ts does). They register
// like built-in types, so a test that loads and unloads project scripts puts them back.
import "../../samples/flappy/scripts/data";
import "../../samples/flappy/scripts/systems";
import "../../samples/flappy/scripts/behaviors/Bird";
import "../../samples/flappy/scripts/behaviors/PipeSpawner";
import "../../samples/flappy/scripts/behaviors/GameManager";
