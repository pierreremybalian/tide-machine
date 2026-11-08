// Registers every stage script (each src/script/<stage>.ts calls registerStage on import).
import.meta.glob(['./*.ts', '!./index.ts', '!./all.ts'], { eager: true });
