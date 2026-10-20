// KASALA! client entry. Complete.
import "./ui/theme.css";
import { Game } from "./Game";

const game = new Game(document.getElementById("game")!, document.getElementById("ui")!);
void game.start();
