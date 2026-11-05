<?php
if ( ! function_exists( 'pg_dup_fn' ) ) {
	function pg_dup_fn() {
		return 'a';
	}
}
if ( function_exists( 'pg_pos_fn' ) ) {
	function pg_pos_fn() {
		return 'a';
	}
}
if ( ! function_exists( 'pg_else_fn' ) ) {
	$x = 1;
} else {
	function pg_else_fn() {
		return 'a';
	}
}
if ( ! class_exists( 'PG_Dup_Class' ) ) {
	class PG_Dup_Class {
		public function run() {}
	}
}
if ( class_exists( 'PG_Pos_Class' ) ) {
	class PG_Pos_Class {}
}
if ( ! function_exists( 'pg_and_fn' ) && $ok ) {
	function pg_and_fn() {}
}
if ( ! defined( 'PG_DUP_CONST' ) ) {
	define( 'PG_DUP_CONST', 1 );
}
if ( defined( 'PG_POS_CONST' ) ) {
	define( 'PG_POS_CONST', 1 );
}
if ( ! defined( 'PG_ELSE_CONST' ) ) {
	$x = 1;
} else {
	define( 'PG_ELSE_CONST', 1 );
}
define( 'PG_BARE_CONST', 1 );
