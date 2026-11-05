<?php
function pg_dup_fn() {
	return 'b';
}
function pg_pos_fn() {
	return 'b';
}
function pg_else_fn() {
	return 'b';
}
class PG_Dup_Class {
}
class PG_Pos_Class {
}
function pg_and_fn() {
}
define( 'PG_DUP_CONST', 2 );
define( 'PG_POS_CONST', 2 );
define( 'PG_ELSE_CONST', 2 );
define( 'PG_BARE_CONST', 2 );
add_action( 'template_redirect', 'pgb_go' );
function pgb_go() {
	wp_safe_redirect( '/b' );
}
