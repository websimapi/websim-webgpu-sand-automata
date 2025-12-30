import { SIMULATION_SHADER, RENDER_SHADER, CLEAR_SHADER, INPUT_SHADER } from './shaders.js';

const WIDTH = 1280;
const HEIGHT = 720;
const WORKGROUP_SIZE = 16;

const canvas = document.getElementById('gpuCanvas');
const fpsElem = document.getElementById('fps');
canvas.width = WIDTH;
canvas.height = HEIGHT;

let device, context;
let pipelineSimulation, pipelineRender, pipelineClear, pipelineInput;
let bufferGridA, bufferGridB, bufferUniforms, bufferInput;
let bindGroupSimA, bindGroupSimB; // A->B, B->A
let bindGroupRenderA, bindGroupRenderB;
let bindGroupClearA, bindGroupClearB;
let bindGroupInputA, bindGroupInputB;

const MAX_INPUTS = 65536; // Max pixels to update per frame

let frameCount = 0;
let lastTime = 0;
let isDrawing = false;
let inputQueue = []; // Pixels to add sand to

async function init() {
    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    context = canvas.getContext('webgpu');

    context.configure({
        device: device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
    });

    createAssets();
    createPipelines();
    createBindGroups();
    setupInput();

    requestAnimationFrame(loop);
}

function createAssets() {
    // Grid Size in bytes (u32 per cell)
    const gridSize = WIDTH * HEIGHT * 4;

    // Buffer A
    bufferGridA = device.createBuffer({
        size: gridSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Buffer B
    bufferGridB = device.createBuffer({
        size: gridSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Uniforms (Width, Height, Frame, InputCount)
    bufferUniforms = device.createBuffer({
        size: 16, // 4 * u32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Input Buffer
    bufferInput = device.createBuffer({
        size: MAX_INPUTS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initial Uniforms
    device.queue.writeBuffer(bufferUniforms, 0, new Uint32Array([WIDTH, HEIGHT, 0, 0]));
}

function createPipelines() {
    const moduleSim = device.createShaderModule({ code: SIMULATION_SHADER });
    const moduleRender = device.createShaderModule({ code: RENDER_SHADER });
    const moduleClear = device.createShaderModule({ code: CLEAR_SHADER });
    const moduleInput = device.createShaderModule({ code: INPUT_SHADER });

    // Compute Pipeline
    pipelineSimulation = device.createComputePipeline({
        layout: 'auto',
        compute: { module: moduleSim, entryPoint: 'main' },
    });

    // Input Pipeline
    pipelineInput = device.createComputePipeline({
        layout: 'auto',
        compute: { module: moduleInput, entryPoint: 'main' },
    });

    // Render Pipeline
    pipelineRender = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: moduleRender, entryPoint: 'vs_main' },
        fragment: {
            module: moduleRender,
            entryPoint: 'fs_main',
            targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
        },
        primitive: { topology: 'triangle-list' },
    });

    // Clear Pipeline
    pipelineClear = device.createComputePipeline({
        layout: 'auto',
        compute: { module: moduleClear, entryPoint: 'main' },
    });
}

function createBindGroups() {
    // Simulation Bind Groups
    // Group 0: Current(ReadWrite), Next(ReadWrite), Uniforms
    bindGroupSimA = device.createBindGroup({
        layout: pipelineSimulation.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridA } },
            { binding: 1, resource: { buffer: bufferGridB } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });

    bindGroupSimB = device.createBindGroup({
        layout: pipelineSimulation.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridB } },
            { binding: 1, resource: { buffer: bufferGridA } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });

    // Render Bind Groups
    // Group 0: Grid(Read), Uniforms
    bindGroupRenderA = device.createBindGroup({
        layout: pipelineRender.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridA } },
            { binding: 1, resource: { buffer: bufferUniforms } },
        ],
    });

    bindGroupRenderB = device.createBindGroup({
        layout: pipelineRender.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridB } },
            { binding: 1, resource: { buffer: bufferUniforms } },
        ],
    });

    // Clear Bind Groups
    // Group 0: Grid(ReadWrite)
    bindGroupClearA = device.createBindGroup({
        layout: pipelineClear.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: bufferGridA } }],
    });

    bindGroupClearB = device.createBindGroup({
        layout: pipelineClear.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: bufferGridB } }],
    });

    // Input Bind Groups
    // Group 0: Inputs(Read), Grid(ReadWrite), Uniforms
    bindGroupInputA = device.createBindGroup({
        layout: pipelineInput.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferInput } },
            { binding: 1, resource: { buffer: bufferGridA } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });

    bindGroupInputB = device.createBindGroup({
        layout: pipelineInput.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferInput } },
            { binding: 1, resource: { buffer: bufferGridB } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });
}

function setupInput() {
    const addInput = (e) => {
        if (!isDrawing) return;
        const rect = canvas.getBoundingClientRect();
        
        let clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        // Map to canvas coordinates
        const x = Math.floor((clientX - rect.left) / rect.width * WIDTH);
        const y = Math.floor((clientY - rect.top) / rect.height * HEIGHT);

        // Brush Size
        const radius = 5;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx*dx + dy*dy <= radius*radius) {
                    const px = x + dx;
                    const py = y + dy;
                    if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
                        // Random sparsity for sand effect
                        if (Math.random() > 0.5) {
                            inputQueue.push(py * WIDTH + px);
                        }
                    }
                }
            }
        }
    };

    canvas.addEventListener('mousedown', (e) => { isDrawing = true; addInput(e); });
    window.addEventListener('mouseup', () => isDrawing = false);
    canvas.addEventListener('mousemove', addInput);
    
    canvas.addEventListener('touchstart', (e) => { isDrawing = true; addInput(e); e.preventDefault(); }, {passive: false});
    window.addEventListener('touchend', () => isDrawing = false);
    canvas.addEventListener('touchmove', (e) => { addInput(e); e.preventDefault(); }, {passive: false});
}

function loop(timestamp) {
    if (timestamp - lastTime >= 1000) {
        fpsElem.innerText = Math.round(1000 / (timestamp - lastTime) * 60); // Approx
        lastTime = timestamp;
    }

    const commandEncoder = device.createCommandEncoder();

    // Determine Buffer pointers
    // Frame 0: Read A, Write B
    // Frame 1: Read B, Write A
    const useAasInput = frameCount % 2 === 0;
    
    const inputBuffer = useAasInput ? bufferGridA : bufferGridB;
    const outputBuffer = useAasInput ? bufferGridB : bufferGridA;
    const simBindGroup = useAasInput ? bindGroupSimA : bindGroupSimB;
    const clearBindGroupForOutput = useAasInput ? bindGroupClearB : bindGroupClearA;
    const renderBindGroup = useAasInput ? bindGroupRenderB : bindGroupRenderA; // We render the result (output)

    // 1. Process Input (Write to Input Buffer before Sim)
    if (inputQueue.length > 0) {
        const uniqueIndices = [...new Set(inputQueue)];
        inputQueue = []; // Clear queue

        const count = Math.min(uniqueIndices.length, MAX_INPUTS);
        
        if (count > 0) {
            // Upload indices to bufferInput
            const data = new Uint32Array(uniqueIndices.slice(0, count));
            device.queue.writeBuffer(bufferInput, 0, data);

            // Update Input Count Uniform (offset 12 = 3 * 4)
            device.queue.writeBuffer(bufferUniforms, 12, new Uint32Array([count]));

            const pass = commandEncoder.beginComputePass();
            pass.setPipeline(pipelineInput);
            // We write to inputBuffer (Current State) so sim picks it up immediately
            pass.setBindGroup(0, useAasInput ? bindGroupInputA : bindGroupInputB);
            pass.dispatchWorkgroups(Math.ceil(count / 64));
            pass.end();
        }
    }

    // 2. Clear Output Buffer (The "Claims" grid needs to be empty)
    {
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(pipelineClear);
        pass.setBindGroup(0, clearBindGroupForOutput);
        const workgroups = Math.ceil((WIDTH * HEIGHT) / 256);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
    }

    // 3. Update Uniforms (Frame count)
    device.queue.writeBuffer(bufferUniforms, 8, new Uint32Array([frameCount]));

    // 4. Run Simulation
    {
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(pipelineSimulation);
        pass.setBindGroup(0, simBindGroup);
        pass.dispatchWorkgroups(Math.ceil(WIDTH / 16), Math.ceil(HEIGHT / 16));
        pass.end();
    }

    // 5. Render Result
    {
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }]
        });
        pass.setPipeline(pipelineRender);
        pass.setBindGroup(0, renderBindGroup);
        pass.draw(6);
        pass.end();
    }

    device.queue.submit([commandEncoder.finish()]);

    frameCount++;
    requestAnimationFrame(loop);
}

init();