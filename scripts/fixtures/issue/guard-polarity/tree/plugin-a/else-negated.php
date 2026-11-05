<?php
if ( ! function_exists( 'create_function' ) ) {
	$x = 1;
} else {
	create_function( '$a', 'return $a;' );
}
if ( function_exists( 'create_function' ) ) {
	$x = 2;
} else {
	create_function( '$a', 'return $a;' );
}
